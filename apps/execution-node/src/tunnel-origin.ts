import {
  tunnelWelcomeSigningPayload,
  type TunnelNodeWelcome,
} from "@glass/contracts/connect-tunnel";
import {
  decodeConnectClientFrame,
  maxConnectFrameBytes,
  type ConnectClientFrame,
  type ConnectNodeDispatch,
  type ConnectNodeReply,
  type ConnectOperationCancel,
} from "@glass/contracts/connect";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import type { ConnectNodeHandler } from "./connect.ts";
import type { FrameDeliveryJournal } from "./frame-delivery-journal.ts";
import { signChallenge, type StoredNodeIdentity } from "./identity.ts";
import type { TunnelControl } from "./tunnel-control.ts";

const maxConnections = 64;
const maxInFlightFramesPerSession = 32;
const maxPendingReplyFrames = 256;
const maxPendingReplyBytes = 4 * 1_048_576;

export type TunnelOriginAuthority = Readonly<{
  hostname: string;
  identity: StoredNodeIdentity;
}>;

export type TunnelOrigin = Readonly<{
  localOrigin: string;
  stop(): Promise<void>;
}>;

export const startTunnelOrigin = async (
  options: Readonly<{
    control: TunnelControl;
    getAuthority: () => Promise<TunnelOriginAuthority>;
    handleDispatch: ConnectNodeHandler;
    journal?: FrameDeliveryJournal;
  }>,
): Promise<TunnelOrigin> => {
  const sockets = new Set<Duplex>();
  const server = createServer((_, response) => {
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxConnectFrameBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has("glass-connect-v2") ? "glass-connect-v2" : false,
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (request.url !== "/v1/connect" || webSockets.clients.size >= maxConnections) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      const key = request.headers["sec-websocket-key"];
      const protocols = request.headers["sec-websocket-protocol"];
      if (
        typeof key !== "string" ||
        Buffer.from(key, "base64").byteLength !== 16 ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        request.headers["sec-websocket-version"] !== "13" ||
        typeof protocols !== "string" ||
        protocols.length > 8_192
      ) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const protocolValues = protocols.split(",").map((value) => value.trim());
      if (
        protocolValues.length !== 2 ||
        protocolValues[0] !== "glass-connect-v2" ||
        !protocolValues[1]?.startsWith("glass-ticket.")
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const ticket = protocolValues[1].slice("glass-ticket.".length);
      let validation: Awaited<ReturnType<TunnelControl["validateTicket"]>>;
      let authority: TunnelOriginAuthority;
      try {
        [validation, authority] = await Promise.all([
          options.control.validateTicket(ticket),
          options.getAuthority(),
        ]);
      } catch {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const environment = authority.identity.environment;
      if (
        environment === null ||
        environment.revokedAt !== null ||
        validation.environmentId !== environment.id ||
        validation.organizationId !== environment.organizationId ||
        validation.keyVersion !== environment.keyVersion ||
        validation.hostname !== authority.hostname ||
        Date.parse(validation.expiresAt) <= Date.now()
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request);
        const sessionId = validation.sessionId;
        let deliveryQueue = Promise.resolve();
        let pendingReplyFrames = 0;
        let pendingReplyBytes = 0;
        let overflowCancellationStarted = false;
        const activeTasks = new Set<Promise<void>>();
        const inFlightOperations = new Set<string>();
        const finishedOperations = new Set<string>();
        const requestGrants = new Map<
          string,
          Readonly<{ dispatchGrant: string; requestId: string }>
        >();
        const fail = (): void => {
          if (webSocket.readyState === WebSocket.OPEN)
            webSocket.close(1008, "Tunnel authorization failed.");
        };
        webSocket.on("error", () => {
          // Protocol and payload violations are closed by ws; the listener prevents process errors.
        });
        const deliver = (reply: ConnectNodeReply): void => {
          const encoded = JSON.stringify(reply.frame);
          const bytes = Buffer.byteLength(encoded);
          if (
            reply.channelId !== sessionId ||
            pendingReplyFrames >= maxPendingReplyFrames ||
            pendingReplyBytes + bytes > maxPendingReplyBytes
          ) {
            if (!overflowCancellationStarted) {
              overflowCancellationStarted = true;
              const grant = requestGrants.get(reply.frame.operationId);
              if (grant !== undefined) {
                requestGrants.delete(reply.frame.operationId);
                const cancel: ConnectOperationCancel = {
                  type: "operation.cancel",
                  requestId: `${grant.requestId}:backpressure`,
                  operationId: reply.frame.operationId,
                  dispatchGrant: grant.dispatchGrant,
                  reason: "Client delivery backpressure exceeded its bound.",
                };
                void dispatchLocalSafetyCancel(cancel);
              }
            }
            fail();
            return;
          }
          pendingReplyFrames += 1;
          pendingReplyBytes += bytes;
          deliveryQueue = deliveryQueue
            .then(async () => {
              if (options.journal === undefined)
                await options.control.recordFrame(sessionId, reply.frame);
              else await options.journal.record(sessionId, reply.frame);
              if (webSocket.readyState === WebSocket.OPEN) webSocket.send(encoded);
            })
            .catch(() => fail())
            .finally(() => {
              pendingReplyFrames -= 1;
              pendingReplyBytes -= bytes;
            });
        };
        const dispatchLocalSafetyCancel = async (frame: ConnectOperationCancel): Promise<void> => {
          const dispatch: ConnectNodeDispatch = {
            type: "relay.dispatch",
            channelId: sessionId,
            frame,
          };
          await options.handleDispatch(dispatch, (reply) => {
            void options.control.recordFrame(sessionId, reply.frame).catch(() => fail());
          });
        };
        const dispatchFrame = async (frame: ConnectClientFrame): Promise<void> => {
          const claimed = await options.control.validateDispatch(sessionId, frame);
          if (claimed.sessionId !== sessionId) return fail();
          if (frame.type === "operation.request") {
            if (
              inFlightOperations.has(frame.operationId) ||
              finishedOperations.has(frame.operationId)
            )
              return fail();
            inFlightOperations.add(frame.operationId);
            requestGrants.set(frame.operationId, {
              dispatchGrant: frame.dispatchGrant,
              requestId: frame.requestId,
            });
          }
          const dispatch: ConnectNodeDispatch = {
            type: "relay.dispatch",
            channelId: sessionId,
            frame,
          };
          try {
            await options.handleDispatch(dispatch, (reply) => {
              if (
                frame.type === "operation.request" &&
                (reply.frame.type === "operation.error" ||
                  (reply.frame.type === "operation.event" && reply.frame.event === "result"))
              ) {
                finishedOperations.add(frame.operationId);
                if (finishedOperations.size > 1_000) {
                  const oldest = finishedOperations.values().next().value;
                  if (oldest !== undefined) finishedOperations.delete(oldest);
                }
              }
              deliver(reply);
            });
            await deliveryQueue;
          } finally {
            if (frame.type === "operation.request") {
              inFlightOperations.delete(frame.operationId);
              requestGrants.delete(frame.operationId);
            }
          }
        };
        webSocket.on("message", (data, isBinary) => {
          if (isBinary) return webSocket.close(1003, "Glass Connect accepts text frames only.");
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString("utf8")) as unknown;
          } catch {
            return fail();
          }
          const frame = decodeConnectClientFrame(parsed);
          if (!frame.ok) return fail();
          if (activeTasks.size >= maxInFlightFramesPerSession) return fail();
          const task = dispatchFrame(frame.value)
            .catch(() => fail())
            .finally(() => activeTasks.delete(task));
          activeTasks.add(task);
        });
        const unsigned: Omit<TunnelNodeWelcome, "signature"> = {
          type: "node.welcome",
          protocolVersion: 2,
          clientNonce: validation.clientNonce,
          environmentId: validation.environmentId,
          expiresAt: validation.expiresAt,
          hostname: validation.hostname,
          keyVersion: validation.keyVersion,
          organizationId: validation.organizationId,
          serverNonce: randomBytes(32).toString("base64url"),
          sessionId: validation.sessionId,
          ticketId: validation.ticketId,
        };
        webSocket.send(
          JSON.stringify({
            ...unsigned,
            signature: signChallenge(authority.identity, tunnelWelcomeSigningPayload(unsigned)),
          } satisfies TunnelNodeWelcome),
        );
      });
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback origin did not bind.");
  return {
    localOrigin: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      webSockets.close();
    },
  };
};
