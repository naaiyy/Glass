import type { ConnectNodeFrame } from "@glass/contracts/connect";
import { describe, expect, it } from "vite-plus/test";
import { WebSocket as NodeWebSocket } from "ws";

import { createNodeIdentity } from "./identity.ts";
import type { TunnelControl } from "./tunnel-control.ts";
import { startTunnelOrigin } from "./tunnel-origin.ts";

const environmentId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";

const authority = () => {
  const identity = createNodeIdentity("https://api.glass.test");
  return {
    hostname: "node.glass.test",
    identity: {
      ...identity,
      environment: {
        id: environmentId,
        organizationId,
        displayName: "Test Node",
        platform: "macos",
        publicKey: identity.publicKey,
        keyVersion: 1,
        createdByUserId: actorUserId,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        revokedAt: null,
      },
    } as never,
  };
};

describe("managed tunnel loopback origin", () => {
  it("consumes the ticket before upgrade and durably records before forwarding", async () => {
    const order: string[] = [];
    const control: TunnelControl = {
      configure: async () => ({
        tunnelId: environmentId,
        hostname: "node.glass.test",
        token: "t".repeat(32),
      }),
      publishPresence: async () => undefined,
      validateTicket: async () => {
        order.push("ticket");
        return {
          actorUserId: actorUserId as never,
          clientNonce: "n".repeat(43),
          environmentId: environmentId as never,
          expiresAt: "2030-01-01T00:00:00.000Z" as never,
          hostname: "node.glass.test",
          keyVersion: 1,
          organizationId: organizationId as never,
          sessionId: "session-1",
          ticketId: "ticket-1",
        };
      },
      validateDispatch: async (sessionId) => {
        order.push("claim");
        return { sessionId };
      },
      recordFrame: async () => {
        order.push("record");
      },
    };
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: (dispatch, reply) => {
        order.push("execute");
        reply({
          type: "relay.reply",
          channelId: dispatch.channelId,
          frame: {
            type: "operation.event",
            requestId: dispatch.frame.requestId,
            operationId: dispatch.frame.operationId,
            event: "result",
            sequence: 0,
            payload: { ok: true },
          },
        });
      },
    });
    const socket = new WebSocket(`${origin.localOrigin.replace("http:", "ws:")}/v1/connect`, [
      "glass-connect-v2",
      `glass-ticket.${"x".repeat(43)}`,
    ]);
    const messages: ConnectNodeFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      socket.addEventListener("message", (event) => {
        const value = JSON.parse(String(event.data)) as { type: string };
        if (value.type === "node.welcome") {
          socket.send(
            JSON.stringify({
              type: "operation.request",
              requestId: "request-1",
              operationId: "operation-1",
              capability: "file.list",
              dispatchGrant: "g".repeat(32),
              payload: { operation: "file.list", workspaceId, path: "." },
            }),
          );
        } else {
          messages.push(value as ConnectNodeFrame);
          resolve();
        }
      });
    });
    expect(socket.protocol).toBe("glass-connect-v2");
    expect(messages).toHaveLength(1);
    expect(order).toEqual(["ticket", "claim", "execute", "record"]);
    socket.close();
    await origin.stop();
  });

  it("rejects a ticket before returning WebSocket 101", async () => {
    const control = {
      validateTicket: async () => {
        throw new Error("consumed");
      },
    } as unknown as TunnelControl;
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: () => undefined,
    });
    const socket = new WebSocket(`${origin.localOrigin.replace("http:", "ws:")}/v1/connect`, [
      "glass-connect-v2",
      `glass-ticket.${"x".repeat(43)}`,
    ]);
    await new Promise<void>((resolve) => {
      socket.addEventListener("error", () => resolve(), { once: true });
    });
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
    await origin.stop();
  });

  it("claims and processes same-socket cancellation while a request is running", async () => {
    const order: string[] = [];
    let releaseRequest: (() => void) | undefined;
    const control = {
      validateTicket: async () => ({
        actorUserId: actorUserId as never,
        clientNonce: "n".repeat(43),
        environmentId: environmentId as never,
        expiresAt: "2030-01-01T00:00:00.000Z" as never,
        hostname: "node.glass.test",
        keyVersion: 1,
        organizationId: organizationId as never,
        sessionId: "session-cancel",
        ticketId: "ticket-cancel",
      }),
      validateDispatch: async (sessionId: string, frame: { type: string }) => {
        order.push(frame.type === "operation.cancel" ? "claim-cancel" : "claim-request");
        return { sessionId };
      },
      recordFrame: async (_sessionId: string, frame: ConnectNodeFrame) => {
        order.push(frame.type === "operation.error" ? "record-cancel" : "record-result");
      },
    } as unknown as TunnelControl;
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: async (dispatch, reply) => {
        if (dispatch.frame.type === "operation.cancel") {
          order.push("execute-cancel");
          reply({
            type: "relay.reply",
            channelId: dispatch.channelId,
            frame: {
              type: "operation.error",
              requestId: dispatch.frame.requestId,
              operationId: dispatch.frame.operationId,
              error: { code: "EXECUTION_CANCELLED", message: "Cancelled", retryable: false },
            },
          });
          releaseRequest?.();
          return;
        }
        order.push("execute-request");
        await new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
      },
    });
    const socket = new NodeWebSocket(`${origin.localOrigin.replace("http:", "ws:")}/v1/connect`, [
      "glass-connect-v2",
      `glass-ticket.${"x".repeat(43)}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString("utf8")) as { type: string };
        if (value.type === "node.welcome") {
          socket.send(
            JSON.stringify({
              type: "operation.request",
              requestId: "request-long",
              operationId: "operation-long",
              capability: "command.run",
              dispatchGrant: "g".repeat(32),
              payload: {},
            }),
          );
          socket.send(
            JSON.stringify({
              type: "operation.cancel",
              requestId: "request-cancel",
              operationId: "operation-long",
              dispatchGrant: "c".repeat(32),
              reason: "User cancelled",
            }),
          );
        } else if (value.type === "operation.error") {
          order.push("client-cancel");
          resolve();
        }
      });
    });
    expect(order).toContain("execute-cancel");
    expect(order.indexOf("record-cancel")).toBeLessThan(order.indexOf("client-cancel"));
    socket.close();
    await origin.stop();
  });

  it("supports ping and fragmented text while rejecting invalid and oversized frames", async () => {
    const control = {
      validateTicket: async () => ({
        actorUserId: actorUserId as never,
        clientNonce: "n".repeat(43),
        environmentId: environmentId as never,
        expiresAt: "2030-01-01T00:00:00.000Z" as never,
        hostname: "node.glass.test",
        keyVersion: 1,
        organizationId: organizationId as never,
        sessionId: "session-ws",
        ticketId: "ticket-ws",
      }),
      validateDispatch: async (sessionId: string) => ({ sessionId }),
      recordFrame: async () => undefined,
    } as unknown as TunnelControl;
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: (dispatch, reply) =>
        reply({
          type: "relay.reply",
          channelId: dispatch.channelId,
          frame: {
            type: "operation.event",
            requestId: dispatch.frame.requestId,
            operationId: dispatch.frame.operationId,
            event: "result",
            sequence: 0,
            payload: {},
          },
        }),
    });
    const url = `${origin.localOrigin.replace("http:", "ws:")}/v1/connect`;
    const protocols = ["glass-connect-v2", `glass-ticket.${"x".repeat(43)}`];
    const fragmented = new NodeWebSocket(url, protocols);
    let pong = false;
    await new Promise<void>((resolve, reject) => {
      fragmented.once("error", reject);
      fragmented.once("pong", () => {
        pong = true;
      });
      fragmented.on("message", (data) => {
        const value = JSON.parse(data.toString("utf8")) as { type: string };
        if (value.type === "node.welcome") {
          fragmented.ping();
          const frame = JSON.stringify({
            type: "operation.request",
            requestId: "fragmented",
            operationId: "fragmented-op",
            capability: "file.list",
            dispatchGrant: "g".repeat(32),
            payload: {},
          });
          fragmented.send(frame.slice(0, 30), { fin: false });
          fragmented.send(frame.slice(30), { fin: true });
        } else resolve();
      });
    });
    expect(pong).toBe(true);
    fragmented.close();
    const invalid = new NodeWebSocket(url, protocols);
    const invalidCode = await new Promise<number>((resolve) => {
      invalid.once("open", () => invalid.send("not-json"));
      invalid.once("close", (code) => resolve(code));
    });
    expect(invalidCode).toBe(1008);
    const oversized = new NodeWebSocket(url, protocols);
    const oversizedCode = await new Promise<number>((resolve) => {
      oversized.once("open", () => oversized.send("x".repeat(1_048_577)));
      oversized.once("close", (code) => resolve(code));
    });
    expect(oversizedCode).toBe(1009);
    await origin.stop();
  });

  it("bounds pending replies and claims cancellation on delivery backpressure", async () => {
    let safetyCancellationExecuted = false;
    const control = {
      validateTicket: async () => ({
        actorUserId: actorUserId as never,
        clientNonce: "n".repeat(43),
        environmentId: environmentId as never,
        expiresAt: "2030-01-01T00:00:00.000Z" as never,
        hostname: "node.glass.test",
        keyVersion: 1,
        organizationId: organizationId as never,
        sessionId: "session-pressure",
        ticketId: "ticket-pressure",
      }),
      validateDispatch: async (sessionId: string) => ({ sessionId }),
      recordFrame: async () => new Promise<void>(() => undefined),
    } as unknown as TunnelControl;
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: (dispatch, reply) => {
        if (dispatch.frame.type === "operation.cancel") {
          safetyCancellationExecuted = true;
          return;
        }
        for (let sequence = 0; sequence < 300; sequence += 1)
          reply({
            type: "relay.reply",
            channelId: dispatch.channelId,
            frame: {
              type: "operation.event",
              requestId: dispatch.frame.requestId,
              operationId: dispatch.frame.operationId,
              event: "progress",
              sequence,
              payload: { data: "x", stream: "stdout" },
            },
          });
      },
    });
    const socket = new NodeWebSocket(`${origin.localOrigin.replace("http:", "ws:")}/v1/connect`, [
      "glass-connect-v2",
      `glass-ticket.${"x".repeat(43)}`,
    ]);
    await new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString("utf8")) as { type: string };
        if (value.type === "node.welcome")
          socket.send(
            JSON.stringify({
              type: "operation.request",
              requestId: "pressure",
              operationId: "pressure-operation",
              capability: "command.run",
              dispatchGrant: "g".repeat(32),
              payload: {},
            }),
          );
      });
      socket.once("close", () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(safetyCancellationExecuted).toBe(true);
    await origin.stop();
  });

  it("executes a duplicate in-flight operation only once", async () => {
    let executions = 0;
    const control = {
      validateTicket: async () => ({
        actorUserId: actorUserId as never,
        clientNonce: "n".repeat(43),
        environmentId: environmentId as never,
        expiresAt: "2030-01-01T00:00:00.000Z" as never,
        hostname: "node.glass.test",
        keyVersion: 1,
        organizationId: organizationId as never,
        sessionId: "session-duplicate",
        ticketId: "ticket-duplicate",
      }),
      validateDispatch: async (sessionId: string) => ({ sessionId }),
      recordFrame: async () => undefined,
    } as unknown as TunnelControl;
    const origin = await startTunnelOrigin({
      control,
      getAuthority: async () => authority(),
      handleDispatch: async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    const socket = new NodeWebSocket(`${origin.localOrigin.replace("http:", "ws:")}/v1/connect`, [
      "glass-connect-v2",
      `glass-ticket.${"x".repeat(43)}`,
    ]);
    await new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString("utf8")) as { type: string };
        if (value.type !== "node.welcome") return;
        const frame = JSON.stringify({
          type: "operation.request",
          requestId: "duplicate-request",
          operationId: "duplicate-operation",
          capability: "command.run",
          dispatchGrant: "g".repeat(32),
          payload: {},
        });
        socket.send(frame);
        socket.send(frame);
      });
      socket.once("close", () => resolve());
    });
    expect(executions).toBe(1);
    await origin.stop();
  });
});
