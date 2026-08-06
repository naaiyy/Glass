import { describe, expect, it } from "vite-plus/test";
import { decodeExecutionRequest } from "./execution.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";

describe("execution request contract", () => {
  it("decodes a bounded command without a shell", () => {
    expect(
      decodeExecutionRequest({
        operation: "command.run",
        workspaceId,
        command: "/usr/bin/printf",
        args: ["hello"],
        cwd: "src",
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects unbounded and unknown operations", () => {
    expect(decodeExecutionRequest({ operation: "shell.eval", workspaceId })).toMatchObject({
      ok: false,
    });
    expect(
      decodeExecutionRequest({
        operation: "command.run",
        workspaceId,
        command: "echo",
        args: [],
        cwd: "",
        timeoutMs: 600_001,
      }),
    ).toMatchObject({ ok: false });
  });

  it("allows only constrained Git mutations", () => {
    expect(
      decodeExecutionRequest({
        operation: "git.run",
        workspaceId,
        subcommand: "push",
        args: [],
      }),
    ).toMatchObject({ ok: false });
  });

  it("requires terminal control messages to carry their workspace scope", () => {
    expect(
      decodeExecutionRequest({
        operation: "terminal.input",
        terminalId: "terminal-1",
        data: "pwd\n",
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeExecutionRequest({
        operation: "terminal.resize",
        terminalId: "terminal-1",
        cols: 100,
        rows: 40,
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeExecutionRequest({ operation: "terminal.close", terminalId: "terminal-1" }),
    ).toMatchObject({ ok: false });
    expect(
      decodeExecutionRequest({
        operation: "terminal.input",
        workspaceId,
        terminalId: "terminal-1",
        data: "pwd\n",
      }),
    ).toMatchObject({ ok: true, value: { workspaceId } });
  });
});
