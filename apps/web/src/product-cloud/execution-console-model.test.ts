import type { WorkspaceId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";

import {
  buildExecutionRequest,
  initialExecutionConsoleFields,
  utf8ToBase64,
  type ConsoleOperation,
} from "./execution-console-model.ts";

const workspaceId = "00000000-0000-4000-8000-000000000001" as WorkspaceId;

describe("execution console request model", () => {
  it.each([
    "file.list",
    "file.read",
    "file.write",
    "command.run",
    "terminal.open",
    "terminal.input",
    "terminal.resize",
    "terminal.close",
    "git.status",
    "git.diff",
    "git.run",
    "checkpoint.list",
    "checkpoint.create",
  ] satisfies readonly ConsoleOperation[])("builds a contract-valid %s request", (operation) => {
    expect(
      buildExecutionRequest(operation, workspaceId, initialExecutionConsoleFields),
    ).toMatchObject({ operation, workspaceId });
  });

  it("encodes file writes as UTF-8 rather than corrupting non-ASCII text", () => {
    const request = buildExecutionRequest("file.write", workspaceId, {
      ...initialExecutionConsoleFields,
      content: "Glass · verre 🪟",
      path: "notes/glass.txt",
    });
    expect(request).toMatchObject({
      operation: "file.write",
      contentBase64: utf8ToBase64("Glass · verre 🪟"),
      path: "notes/glass.txt",
    });
  });

  it("preserves argument boundaries without invoking a shell parser", () => {
    expect(
      buildExecutionRequest("command.run", workspaceId, {
        ...initialExecutionConsoleFields,
        args: '["hello world", "$(not-expanded)"]',
        command: "printf",
      }),
    ).toMatchObject({ args: ["hello world", "$(not-expanded)"], command: "printf" });
  });

  it("rejects malformed argument input before creating a durable Cloud operation", () => {
    expect(() =>
      buildExecutionRequest("git.run", workspaceId, {
        ...initialExecutionConsoleFields,
        args: "status --short",
      }),
    ).toThrow(/JSON array/u);
  });

  it("requires a contract-valid checkpoint identifier", () => {
    expect(() =>
      buildExecutionRequest("checkpoint.restore", workspaceId, {
        ...initialExecutionConsoleFields,
        checkpointId: "not-a-checkpoint",
      }),
    ).toThrow(/outside the accepted range/u);
  });

  it("builds a checkpoint restore request from a durable checkpoint ID", () => {
    expect(
      buildExecutionRequest("checkpoint.restore", workspaceId, {
        ...initialExecutionConsoleFields,
        checkpointId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toMatchObject({
      operation: "checkpoint.restore",
      checkpointId: "00000000-0000-4000-8000-000000000002",
      workspaceId,
    });
  });
});
