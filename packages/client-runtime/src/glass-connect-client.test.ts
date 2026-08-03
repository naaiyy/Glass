import type { ConnectTicket } from "@glass/contracts/connect";
import type { ExecutionEnvironmentId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";

import {
  GlassConnectClient,
  clientReconnectDelayMilliseconds,
  maxActiveConnectCorrelations,
  type ClientConnectSocket,
} from "./glass-connect-client.ts";

class FakeSocket implements ClientConnectSocket {
  readyState = 0;
  sent: string[] = [];
  closed: Readonly<{ code?: number; reason?: string }> | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: { data: unknown } | undefined) => void>
  >();
  addEventListener(
    type: "close" | "error" | "message" | "open",
    listener: ((event: { data: unknown }) => void) | (() => void),
  ): void {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      (event) => (listener as (value?: { data: unknown }) => void)(event),
    ]);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  send(data: string): void {
    this.sent.push(data);
  }
  emit(type: "close" | "error" | "open"): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(undefined);
  }
  message(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
}

const environmentId = "11111111-1111-4111-8111-111111111111" as ExecutionEnvironmentId;
const organizationId = "22222222-2222-4222-8222-222222222222";
const publicKey = "p".repeat(43);
let latestNonce = "n".repeat(43);
const environmentIdentity = { id: environmentId, keyVersion: 1, organizationId, publicKey };
const ticket = (token: string): ConnectTicket => ({
  ticket: token,
  ticketId: "ticket-1",
  keyVersion: 1,
  publicKey,
  websocketUrl: "wss://glass.test/connect",
  expiresAt: "2030-01-01T00:00:00.000Z" as ConnectTicket["expiresAt"],
});

const authenticate = async (socket: FakeSocket): Promise<void> => {
  socket.message(
    JSON.stringify({
      type: "node.welcome",
      protocolVersion: 2,
      clientNonce: latestNonce,
      environmentId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      hostname: "glass.test",
      keyVersion: 1,
      organizationId,
      serverNonce: "s".repeat(43),
      sessionId: "session-1",
      signature: "x".repeat(86),
      ticketId: "ticket-1",
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
};

describe("Glass Connect client", () => {
  it("uses a fresh ticket after disconnect with bounded reconnect delay", async () => {
    const sockets: FakeSocket[] = [];
    const tickets: string[] = [];
    const scheduled: Array<() => void> = [];
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async (nonce) => {
        latestNonce = nonce;
        const value = `ticket-${tickets.length + 1}`;
        tickets.push(value);
        return ticket(value);
      },
      makeSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: () => undefined,
      random: () => 0,
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    sockets[0]?.emit("open");
    sockets[0]?.emit("close");
    scheduled.shift()?.();
    await Promise.resolve();
    expect(tickets).toEqual(["ticket-1", "ticket-2"]);
    expect(clientReconnectDelayMilliseconds(99, () => 1)).toBe(30_000);
    client.stop();
  });

  it("rejects uncorrelated inbound frames at the typed boundary", async () => {
    const socket = new FakeSocket();
    const frames: unknown[] = [];
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async (nonce) => {
        latestNonce = nonce;
        return ticket("ticket");
      },
      makeSocket: () => socket,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: (frame) => frames.push(frame),
      schedule: () => 1,
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    socket.emit("open");
    await authenticate(socket);
    socket.message(
      JSON.stringify({
        type: "operation.event",
        requestId: "unknown",
        operationId: "unknown",
        event: "result",
        sequence: 0,
        payload: {},
      }),
    );
    expect(frames).toHaveLength(0);
    expect(socket.closed).toMatchObject({ code: 1007 });
  });

  it("does not reuse a request ID for a different operation", async () => {
    const socket = new FakeSocket();
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async (nonce) => {
        latestNonce = nonce;
        return ticket("ticket");
      },
      makeSocket: () => socket,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: () => undefined,
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    socket.emit("open");
    await authenticate(socket);
    expect(
      client.send({
        type: "operation.request",
        requestId: "request-1",
        operationId: "operation-1",
        capability: "file.list",
        dispatchGrant: "g".repeat(32),
        payload: {},
      }),
    ).toBe(true);
    expect(
      client.send({
        type: "operation.request",
        requestId: "request-1",
        operationId: "operation-2",
        capability: "file.list",
        dispatchGrant: "g".repeat(32),
        payload: {},
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(1);
    client.stop();
  });

  it("does not send operations before the signed welcome is verified", async () => {
    const socket = new FakeSocket();
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async (nonce) => {
        latestNonce = nonce;
        return ticket("ticket");
      },
      makeSocket: () => socket,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: () => undefined,
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    socket.emit("open");
    expect(
      client.send({
        type: "operation.request",
        requestId: "request-before-welcome",
        operationId: "operation-before-welcome",
        capability: "file.list",
        dispatchGrant: "g".repeat(32),
        payload: {},
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(0);
    client.stop();
  });

  it("bounds active request correlations", async () => {
    const socket = new FakeSocket();
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async (nonce) => {
        latestNonce = nonce;
        return ticket("ticket");
      },
      makeSocket: () => socket,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: () => undefined,
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    socket.emit("open");
    await authenticate(socket);
    for (let index = 0; index < maxActiveConnectCorrelations; index += 1) {
      expect(
        client.send({
          type: "operation.request",
          requestId: `request-${index}`,
          operationId: `operation-${index}`,
          capability: "file.list",
          dispatchGrant: "g".repeat(32),
          payload: {},
        }),
      ).toBe(true);
    }
    expect(
      client.send({
        type: "operation.request",
        requestId: "overflow",
        operationId: "overflow",
        capability: "file.list",
        dispatchGrant: "g".repeat(32),
        payload: {},
      }),
    ).toBe(false);
    expect(socket.sent).toHaveLength(maxActiveConnectCorrelations);
    client.stop();
  });

  it("treats an expired ticket as execution-only offline state and retries", async () => {
    const statuses: string[] = [];
    const scheduled: Array<() => void> = [];
    let sockets = 0;
    const client = new GlassConnectClient({
      environmentIdentity,
      getTicket: async () => ({
        ...ticket("expired"),
        expiresAt: "2028-01-01T00:00:00.000Z" as ConnectTicket["expiresAt"],
      }),
      makeSocket: () => {
        sockets += 1;
        return new FakeSocket();
      },
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status.status),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      verifyWelcome: async () => true,
    });
    client.start();
    await Promise.resolve();
    expect(sockets).toBe(0);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    expect(scheduled).toHaveLength(1);
    client.stop();
    expect(statuses.at(-1)).toBe("stopped");
  });
});
