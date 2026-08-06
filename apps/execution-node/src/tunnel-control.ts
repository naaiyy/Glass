import {
  decodeManagedTunnelConfiguration,
  decodeValidateClientTicketResponse,
  decodeValidateDispatchResponse,
  type ManagedTunnelConfiguration,
  type PublishNodePresenceRequest,
  type ValidateClientTicketResponse,
  type ValidateDispatchResponse,
} from "@glass/contracts/connect-tunnel";
import type {
  ConnectClientFrame,
  ConnectNodeFrame,
  ConnectNodeHello,
} from "@glass/contracts/connect";
import { decodeEnvironmentIdentityChallenge } from "@glass/contracts/environments";
import type { DecodeResult } from "@glass/contracts/validation";

import { refreshCredential, signChallenge, type StoredNodeIdentity } from "./identity.ts";

export type TunnelIdentityStore = Readonly<{
  load: () => Promise<StoredNodeIdentity>;
  save: (identity: StoredNodeIdentity) => Promise<void>;
}>;

export type TunnelControl = Readonly<{
  configure(localOrigin: string): Promise<ManagedTunnelConfiguration>;
  publishPresence(
    hello: ConnectNodeHello,
    status: PublishNodePresenceRequest["status"],
  ): Promise<void>;
  recordFrame(sessionId: string, frame: ConnectNodeFrame): Promise<void>;
  validateDispatch(sessionId: string, frame: ConnectClientFrame): Promise<ValidateDispatchResponse>;
  validateTicket(ticket: string): Promise<ValidateClientTicketResponse>;
}>;

const responseMessage = (value: unknown, status: number): string =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : `Glass Cloud returned ${status}.`;

export class TunnelControlError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const createTunnelControl = (
  store: TunnelIdentityStore,
  settings: Readonly<{ requestTimeoutMilliseconds?: number }> = {},
): TunnelControl => {
  const requestTimeoutMilliseconds = settings.requestTimeoutMilliseconds ?? 10_000;
  const post = async <Value>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    decode?: (input: unknown) => DecodeResult<Value>,
  ): Promise<Value> => {
    let identity = await store.load();
    identity = await refreshCredential(identity);
    await store.save(identity);
    if (identity.environment === null || identity.credential === null)
      throw new Error("A published execution environment credential is required.");
    const challengeResponse = await fetch(
      new URL("/v1/connect/node-challenges", identity.apiOrigin),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${identity.credential.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          environmentId: identity.environment.id,
          organizationId: identity.environment.organizationId,
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      },
    );
    const challengeValue = (await challengeResponse.json()) as unknown;
    if (!challengeResponse.ok)
      throw new TunnelControlError(
        challengeResponse.status,
        responseMessage(challengeValue, challengeResponse.status),
      );
    const challenge = decodeEnvironmentIdentityChallenge(challengeValue);
    if (!challenge.ok) throw new Error("Glass Cloud returned a malformed proof challenge.");
    const response = await fetch(new URL(path, identity.apiOrigin), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${identity.credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        environmentId: identity.environment.id,
        organizationId: identity.environment.organizationId,
        proofChallengeId: challenge.value.challengeId,
        signature: signChallenge(identity, challenge.value.challenge),
      }),
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    });
    const value = response.status === 204 ? null : ((await response.json()) as unknown);
    if (!response.ok)
      throw new TunnelControlError(response.status, responseMessage(value, response.status));
    if (decode === undefined) return undefined as Value;
    const decoded = decode(value);
    if (!decoded.ok) throw new Error("Glass Cloud returned a malformed tunnel control response.");
    return decoded.value;
  };
  return {
    configure: (localOrigin) =>
      post("/v1/connect/tunnel-configuration", { localOrigin }, decodeManagedTunnelConfiguration),
    publishPresence: (hello, status) =>
      post("/v1/connect/node-presence", {
        capabilities: hello.capabilities,
        status,
        workspaces: hello.workspaces,
      }),
    recordFrame: (sessionId, frame) => post("/v1/connect/operation-events", { sessionId, frame }),
    validateDispatch: (sessionId, frame) =>
      post("/v1/connect/validate-dispatch", { frame, sessionId }, decodeValidateDispatchResponse),
    validateTicket: (ticket) =>
      post("/v1/connect/validate-client-ticket", { ticket }, decodeValidateClientTicketResponse),
  };
};
