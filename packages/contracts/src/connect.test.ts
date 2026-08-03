import { describe, expect, it } from "vite-plus/test";
import {
  decodeConnectClientFrame,
  decodeConnectFrameText,
  decodeConnectNodeHello,
  decodeNodeReply,
  maxConnectFrameBytes,
} from "./connect.ts";

describe("Glass Connect contracts", () => {
  it("validates a bounded operation request", () => {
    expect(
      decodeConnectClientFrame({
        type: "operation.request",
        requestId: "request-1",
        operationId: "operation-1",
        capability: "workspace.read",
        dispatchGrant: "signed-dispatch-grant-that-is-long-enough",
        payload: { path: "README.md" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unknown client variants", () => {
    expect(decodeConnectClientFrame({ type: "shell.exec" })).toMatchObject({
      ok: false,
      issues: [{ path: "$.type", code: "unknown_variant" }],
    });
  });

  it("validates channel-bound node replies", () => {
    expect(
      decodeNodeReply({
        type: "relay.reply",
        channelId: "channel-1",
        frame: {
          type: "operation.event",
          requestId: "request-1",
          operationId: "operation-1",
          event: "result",
          sequence: 2,
          payload: { ok: true },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("accepts a bounded node capability and workspace catalog", () => {
    expect(
      decodeConnectNodeHello({
        type: "node.hello",
        protocolVersion: 1,
        capabilities: ["filesystem", "terminals"],
        workspaces: [{ id: "50000000-0000-4000-8000-000000000001", name: "Glass workspace" }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unknown capabilities and duplicate workspace identities", () => {
    expect(
      decodeConnectNodeHello({
        type: "node.hello",
        protocolVersion: 1,
        capabilities: ["root-shell"],
        workspaces: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeConnectNodeHello({
        type: "node.hello",
        protocolVersion: 1,
        capabilities: ["filesystem"],
        workspaces: [
          { id: "50000000-0000-4000-8000-000000000001", name: "First" },
          { id: "50000000-0000-4000-8000-000000000001", name: "Duplicate" },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects oversized text before parsing", () => {
    expect(
      decodeConnectFrameText(" ".repeat(maxConnectFrameBytes + 1), decodeConnectClientFrame),
    ).toMatchObject({ ok: false, issues: [{ code: "out_of_range" }] });
  });
});
