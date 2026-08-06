import {
  decodeConnectFrameText,
  decodeConnectNodeFrame,
  type ConnectClientFrame,
  type ConnectNodeFrame,
  type ConnectTicket,
} from "@glass/contracts/connect";
import {
  decodeTunnelNodeWelcome,
  tunnelWelcomeSigningPayload,
  type TunnelNodeWelcome,
} from "@glass/contracts/connect-tunnel";
import type { ExecutionEnvironmentId } from "@glass/contracts/ids";

export type GlassConnectClientStatus =
  | Readonly<{ status: "idle" }>
  | Readonly<{ attempt: number; status: "connecting" }>
  | Readonly<{ connectedAt: string; status: "online" }>
  | Readonly<{ attempt: number; retryAt: string; status: "reconnecting" }>
  | Readonly<{ status: "stopped" }>;

export interface ClientConnectSocket {
  readonly protocol?: string;
  readonly readyState: number;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: Readonly<{ data: unknown }>) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type GlassConnectClientOptions = Readonly<{
  cancelSchedule?: (handle: unknown) => void;
  getTicket: (clientNonce: string) => Promise<ConnectTicket>;
  environmentIdentity: Readonly<{
    id: ExecutionEnvironmentId;
    keyVersion: number;
    organizationId: string;
    publicKey: string;
  }>;
  makeSocket: (ticket: ConnectTicket) => ClientConnectSocket;
  now?: () => number;
  onFrame: (frame: ConnectNodeFrame) => void;
  onOnline?: () => void;
  onStatus?: (status: GlassConnectClientStatus) => void;
  random?: () => number;
  schedule?: (callback: () => void, delayMilliseconds: number) => unknown;
  verifyWelcome?: (welcome: TunnelNodeWelcome, publicKey: string) => Promise<boolean>;
}>;

const openReadyState = 1;
export const maxActiveConnectCorrelations = 1_000;

const base64UrlBytes = (value: string): ArrayBuffer => {
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
};

export const verifyTunnelNodeWelcome = async (
  welcome: TunnelNodeWelcome,
  publicKey: string,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlBytes(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlBytes(welcome.signature),
    new TextEncoder().encode(
      tunnelWelcomeSigningPayload({
        type: welcome.type,
        protocolVersion: welcome.protocolVersion,
        clientNonce: welcome.clientNonce,
        environmentId: welcome.environmentId,
        expiresAt: welcome.expiresAt,
        hostname: welcome.hostname,
        keyVersion: welcome.keyVersion,
        organizationId: welcome.organizationId,
        serverNonce: welcome.serverNonce,
        sessionId: welcome.sessionId,
        ticketId: welcome.ticketId,
      }),
    ),
  );
};

export const clientReconnectDelayMilliseconds = (attempt: number, random = Math.random): number => {
  const boundedAttempt = Math.max(0, Math.min(attempt, 8));
  const ceiling = Math.min(30_000, 500 * 2 ** boundedAttempt);
  return Math.floor(ceiling * (0.5 + random() * 0.5));
};

export class GlassConnectClient {
  private readonly options: GlassConnectClientOptions;
  private readonly correlation = new Map<string, string>();
  private socket: ClientConnectSocket | null = null;
  private retryHandle: unknown = null;
  private handshakeHandle: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private authenticated = false;
  private stopped = true;

  constructor(options: GlassConnectClientOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  send(frame: ConnectClientFrame): boolean {
    if (!this.authenticated || this.socket?.readyState !== openReadyState) return false;
    const expected = this.correlation.get(frame.requestId);
    if (expected !== undefined && expected !== frame.operationId) return false;
    if (expected === undefined && this.correlation.size >= maxActiveConnectCorrelations)
      return false;
    // A cancellation grant may be issued to a newly connected client after the original
    // dispatch socket disappeared. The scoped Cloud grant is the authority; retain a fresh
    // correlation here so the terminal node acknowledgement can still be validated.
    if (expected === undefined) this.correlation.set(frame.requestId, frame.operationId);
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryHandle !== null) {
      (this.options.cancelSchedule ?? clearTimeout)(this.retryHandle as never);
      this.retryHandle = null;
    }
    if (this.handshakeHandle !== null) clearTimeout(this.handshakeHandle);
    this.handshakeHandle = null;
    this.socket?.close(1000, "Glass Connect stopped.");
    this.socket = null;
    this.authenticated = false;
    this.correlation.clear();
    this.options.onStatus?.({ status: "stopped" });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const attempt = this.attempt;
    this.options.onStatus?.({ status: "connecting", attempt });
    try {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = btoa(String.fromCharCode(...nonceBytes))
        .replace(/\+/gu, "-")
        .replace(/\//gu, "_")
        .replace(/=+$/gu, "");
      const ticket = await this.options.getTicket(nonce);
      if (this.stopped) return;
      if (Date.parse(ticket.expiresAt) <= (this.options.now ?? Date.now)()) {
        throw new Error("Glass Connect ticket expired before use.");
      }
      const socket = this.options.makeSocket(ticket);
      this.socket = socket;
      let opened = false;
      const expectedHostname = new URL(ticket.websocketUrl).hostname;
      socket.addEventListener("open", () => {
        if (socket !== this.socket || this.stopped) return;
        opened = true;
        this.handshakeHandle = setTimeout(
          () => socket.close(1008, "Execution environment proof timed out."),
          5_000,
        );
        if (socket.protocol !== undefined && socket.protocol !== "glass-connect-v2")
          socket.close(1008, "Glass Connect protocol negotiation failed.");
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          socket.close(1003, "Glass Connect accepts text frames only.");
          return;
        }
        if (!this.authenticated) {
          const welcome = decodeConnectFrameText(event.data, decodeTunnelNodeWelcome);
          if (
            !welcome.ok ||
            welcome.value.environmentId !== this.options.environmentIdentity.id ||
            welcome.value.organizationId !== this.options.environmentIdentity.organizationId ||
            welcome.value.keyVersion !== ticket.keyVersion ||
            ticket.keyVersion !== this.options.environmentIdentity.keyVersion ||
            ticket.publicKey !== this.options.environmentIdentity.publicKey ||
            welcome.value.hostname !== expectedHostname ||
            welcome.value.clientNonce !== nonce ||
            welcome.value.ticketId !== ticket.ticketId ||
            welcome.value.expiresAt !== ticket.expiresAt
          ) {
            socket.close(1008, "Execution environment identity mismatch.");
            return;
          }
          void (this.options.verifyWelcome ?? verifyTunnelNodeWelcome)(
            welcome.value,
            this.options.environmentIdentity.publicKey,
          )
            .then((verified) => {
              if (!verified || socket !== this.socket || this.stopped) {
                socket.close(1008, "Execution environment proof failed.");
                return;
              }
              this.authenticated = true;
              if (this.handshakeHandle !== null) clearTimeout(this.handshakeHandle);
              this.handshakeHandle = null;
              this.attempt = 0;
              this.options.onStatus?.({
                status: "online",
                connectedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
              });
              this.options.onOnline?.();
            })
            .catch(() => socket.close(1008, "Execution environment proof failed."));
          return;
        }
        const decoded = decodeConnectFrameText(event.data, decodeConnectNodeFrame);
        if (
          !decoded.ok ||
          this.correlation.get(decoded.value.requestId) !== decoded.value.operationId
        ) {
          socket.close(1007, "Invalid or uncorrelated Glass Connect frame.");
          return;
        }
        this.options.onFrame(decoded.value);
        if (decoded.value.type === "operation.error" || decoded.value.event === "result")
          this.correlation.delete(decoded.value.requestId);
      });
      const reconnect = (): void => {
        if (this.handshakeHandle !== null) clearTimeout(this.handshakeHandle);
        this.handshakeHandle = null;
        if (socket !== this.socket || this.stopped) return;
        this.socket = null;
        this.authenticated = false;
        this.scheduleReconnect(opened ? 0 : attempt + 1);
      };
      socket.addEventListener("close", reconnect);
      socket.addEventListener("error", reconnect);
    } catch {
      this.scheduleReconnect(attempt + 1);
    }
  }

  private scheduleReconnect(attempt: number): void {
    if (this.stopped || this.retryHandle !== null) return;
    this.attempt = attempt;
    const delay = clientReconnectDelayMilliseconds(attempt, this.options.random);
    this.options.onStatus?.({
      status: "reconnecting",
      attempt,
      retryAt: new Date((this.options.now ?? Date.now)() + delay).toISOString(),
    });
    this.retryHandle = (this.options.schedule ?? setTimeout)(() => {
      this.retryHandle = null;
      void this.connect();
    }, delay);
  }
}
