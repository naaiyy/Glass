import type { ConnectNodeDispatch, ConnectNodeReply } from "@glass/contracts/connect";
import type { WorkspaceId } from "@glass/contracts/ids";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createExecutionNodeHandler } from "./execution-handler.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "glass-execution-test-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  const handler = await createExecutionNodeHandler({
    checkpointRoot: join(root, "checkpoints"),
    workspaces: [
      { id: workspaceId, name: "Fixture", root: workspace },
      { id: otherWorkspaceId, name: "Other", root: otherWorkspace },
    ],
  });
  return { handler, root, workspace };
};

const request = async (
  handler: Awaited<ReturnType<typeof createExecutionNodeHandler>>,
  capability: string,
  payload: unknown,
  operationId = crypto.randomUUID(),
): Promise<ConnectNodeReply[]> => {
  const replies: ConnectNodeReply[] = [];
  const dispatch: ConnectNodeDispatch = {
    type: "relay.dispatch",
    channelId: "test-channel",
    frame: {
      type: "operation.request",
      requestId: crypto.randomUUID(),
      operationId,
      capability,
      payload,
      dispatchGrant: "test-grant",
    },
  };
  await handler(dispatch, (reply) => replies.push(reply));
  return replies;
};

const terminalValue = (replies: readonly ConnectNodeReply[]): unknown => {
  const frame = replies.at(-1)?.frame;
  if (frame?.type !== "operation.event" || frame.event !== "result")
    throw new Error("Expected terminal result.");
  return frame.payload;
};

describe("execution node handler", () => {
  it("lists registered workspaces without exposing host paths", async () => {
    const { handler, workspace } = await setup();
    const replies = await request(handler, "workspace.list", { operation: "workspace.list" });
    expect(terminalValue(replies)).toMatchObject({
      status: "succeeded",
      value: {
        descriptor: { status: "ready" },
        workspaces: [
          { id: workspaceId, name: "Fixture" },
          { id: otherWorkspaceId, name: "Other" },
        ],
      },
    });
    expect(JSON.stringify(replies)).not.toContain(workspace);
  });

  it("reads and atomically writes bounded workspace files", async () => {
    const { handler, workspace } = await setup();
    await writeFile(join(workspace, "hello.txt"), "hello");
    const read = await request(handler, "file.read", {
      operation: "file.read",
      workspaceId,
      path: "hello.txt",
    });
    expect(terminalValue(read)).toMatchObject({
      status: "succeeded",
      value: { contentBase64: Buffer.from("hello").toString("base64"), size: 5 },
    });
    await request(handler, "file.write", {
      operation: "file.write",
      workspaceId,
      path: "nested/output.txt",
      contentBase64: Buffer.from("written").toString("base64"),
      createParents: true,
    });
    expect(await readFile(join(workspace, "nested/output.txt"), "utf8")).toBe("written");
  });

  it("rejects traversal and symbolic-link path escapes", async () => {
    const { handler, root, workspace } = await setup();
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(workspace, "escape"));
    for (const path of ["../secret.txt", "escape"]) {
      // eslint-disable-next-line no-await-in-loop -- each attack case is asserted independently.
      const replies = await request(handler, "file.read", {
        operation: "file.read",
        workspaceId,
        path,
      });
      expect(replies.at(-1)?.frame).toMatchObject({
        type: "operation.error",
        error: { code: "FORBIDDEN" },
      });
    }
  });

  it("streams command output and reports its terminal state", async () => {
    const { handler } = await setup();
    const replies = await request(handler, "command.run", {
      operation: "command.run",
      workspaceId,
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello'); process.stderr.write('warning')"],
      cwd: "",
      timeoutMs: 10_000,
    });
    expect(
      replies.some(
        (reply) =>
          reply.frame.type === "operation.event" &&
          reply.frame.event === "progress" &&
          JSON.stringify(reply.frame.payload).includes("hello"),
      ),
    ).toBe(true);
    expect(terminalValue(replies)).toMatchObject({ status: "succeeded", value: { exitCode: 0 } });
  });

  it("escalates timeout termination when a real child ignores SIGTERM", async () => {
    const { handler } = await setup();
    const startedAt = Date.now();
    const replies = await request(handler, "command.run", {
      operation: "command.run",
      workspaceId,
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      cwd: "",
      timeoutMs: 100,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(replies.at(-1)?.frame).toMatchObject({
      type: "operation.error",
      error: { code: "TIMEOUT" },
    });
  });

  it("runs status, diff, and constrained Git mutations", async () => {
    const { handler, workspace } = await setup();
    await execFileAsync("git", ["init"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "content");
    const status = await request(handler, "git.status", { operation: "git.status", workspaceId });
    expect(JSON.stringify(status)).toContain("tracked.txt");
    const add = await request(handler, "git.run", {
      operation: "git.run",
      workspaceId,
      subcommand: "add",
      args: ["tracked.txt"],
    });
    expect(terminalValue(add)).toMatchObject({ status: "succeeded", value: { exitCode: 0 } });
    const diff = await request(handler, "git.diff", {
      operation: "git.diff",
      workspaceId,
      staged: true,
    });
    expect(JSON.stringify(diff)).toContain("content");
  });

  it("maintains a PTY lifecycle with streamed terminal output", async () => {
    const { handler } = await setup();
    const terminalId = crypto.randomUUID();
    const openReplies: ConnectNodeReply[] = [];
    const opened = handler(
      {
        type: "relay.dispatch",
        channelId: "terminal-channel",
        frame: {
          type: "operation.request",
          requestId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          capability: "terminal.open",
          dispatchGrant: "test-grant",
          payload: {
            operation: "terminal.open",
            workspaceId,
            terminalId,
            cwd: "",
            cols: 80,
            rows: 24,
            shell: "/bin/sh",
          },
        },
      },
      (reply) => openReplies.push(reply),
    );
    await new Promise((complete) => setTimeout(complete, 50));
    const forbidden = await request(handler, "terminal.input", {
      operation: "terminal.input",
      workspaceId: otherWorkspaceId,
      terminalId,
      data: "exit\n",
    });
    expect(forbidden.at(-1)?.frame).toMatchObject({
      type: "operation.error",
      error: { code: "FORBIDDEN" },
    });
    await request(handler, "terminal.resize", {
      operation: "terminal.resize",
      workspaceId,
      terminalId,
      cols: 100,
      rows: 30,
    });
    await request(handler, "terminal.input", {
      operation: "terminal.input",
      workspaceId,
      terminalId,
      data: "printf glass-pty\nexit\n",
    });
    await opened;
    expect(JSON.stringify(openReplies)).toContain("glass-pty");
    expect(terminalValue(openReplies)).toMatchObject({
      status: "succeeded",
      value: { exitCode: 0, terminalId },
    });
  });

  it("rejects terminal control through a different workspace", async () => {
    const { handler } = await setup();
    const terminalId = crypto.randomUUID();
    const opened = handler(
      {
        type: "relay.dispatch",
        channelId: "terminal-owner-channel",
        frame: {
          type: "operation.request",
          requestId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          capability: "terminal.open",
          dispatchGrant: "test-grant",
          payload: {
            operation: "terminal.open",
            workspaceId,
            terminalId,
            cwd: "",
            cols: 80,
            rows: 24,
            shell: "/bin/sh",
          },
        },
      },
      () => undefined,
    );
    await new Promise((complete) => setTimeout(complete, 50));
    const rejected = await request(handler, "terminal.input", {
      operation: "terminal.input",
      workspaceId: otherWorkspaceId,
      terminalId,
      data: "exit\n",
    });
    expect(rejected.at(-1)?.frame).toMatchObject({
      type: "operation.error",
      error: { code: "FORBIDDEN" },
    });
    await request(handler, "terminal.input", {
      operation: "terminal.input",
      workspaceId,
      terminalId,
      data: "exit\n",
    });
    await opened;
  });

  it("cancels an active command with an explicit terminal error", async () => {
    const { handler } = await setup();
    const operationId = crypto.randomUUID();
    const replies: ConnectNodeReply[] = [];
    const running = handler(
      {
        type: "relay.dispatch",
        channelId: "test-channel",
        frame: {
          type: "operation.request",
          requestId: crypto.randomUUID(),
          operationId,
          capability: "command.run",
          dispatchGrant: "test-grant",
          payload: {
            operation: "command.run",
            workspaceId,
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            cwd: "",
            timeoutMs: 60_000,
          },
        },
      },
      (reply) => replies.push(reply),
    );
    await new Promise((complete) => setTimeout(complete, 50));
    await handler(
      {
        type: "relay.dispatch",
        channelId: "test-channel",
        frame: {
          type: "operation.cancel",
          requestId: crypto.randomUUID(),
          operationId,
          reason: "test",
          dispatchGrant: "test-grant",
        },
      },
      (reply) => replies.push(reply),
    );
    await running;
    expect(replies.at(-1)?.frame).toMatchObject({
      type: "operation.error",
      error: { code: "EXECUTION_CANCELLED" },
    });
  });

  it("terminally cancels an operation that is no longer active after reconnect", async () => {
    const { handler } = await setup();
    const replies: ConnectNodeReply[] = [];
    await handler(
      {
        type: "relay.dispatch",
        channelId: "reconnected-channel",
        frame: {
          type: "operation.cancel",
          requestId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          reason: "cancel after node restart",
          dispatchGrant: "test-grant",
        },
      },
      (reply) => replies.push(reply),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.frame).toMatchObject({
      type: "operation.error",
      error: { code: "EXECUTION_CANCELLED", retryable: false },
    });
  });

  it("creates and exactly restores environment-owned checkpoints", async () => {
    const { handler, workspace } = await setup();
    await writeFile(join(workspace, "tracked.txt"), "before");
    const created = await request(handler, "checkpoint.create", {
      operation: "checkpoint.create",
      workspaceId,
      label: "Before",
    });
    const payload = terminalValue(created) as { status: string; value: { id: string } };
    await writeFile(join(workspace, "tracked.txt"), "after");
    await writeFile(join(workspace, "extra.txt"), "extra");
    await request(handler, "checkpoint.restore", {
      operation: "checkpoint.restore",
      workspaceId,
      checkpointId: payload.value.id,
    });
    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("before");
    await expect(readFile(join(workspace, "extra.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("excludes and preserves dependency trees that contain package-manager symlinks", async () => {
    const { handler, root, workspace } = await setup();
    await writeFile(join(workspace, "tracked.txt"), "before");
    const dependencies = join(workspace, "node_modules");
    await mkdir(join(dependencies, ".pnpm", "fixture"), { recursive: true });
    await writeFile(join(dependencies, ".pnpm", "fixture", "index.js"), "export default 1;");
    await symlink(join(dependencies, ".pnpm", "fixture"), join(dependencies, "fixture"));

    const created = await request(handler, "checkpoint.create", {
      operation: "checkpoint.create",
      workspaceId,
      label: "With dependencies",
    });
    const payload = terminalValue(created) as { status: string; value: { id: string } };
    expect(payload.status).toBe("succeeded");

    await writeFile(join(workspace, "tracked.txt"), "after");
    await writeFile(join(dependencies, "installed-after-checkpoint.txt"), "keep");
    await request(handler, "checkpoint.restore", {
      operation: "checkpoint.restore",
      workspaceId,
      checkpointId: payload.value.id,
    });

    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("before");
    expect(await readFile(join(dependencies, "installed-after-checkpoint.txt"), "utf8")).toBe(
      "keep",
    );
    expect(await readFile(join(dependencies, "fixture", "index.js"), "utf8")).toBe(
      "export default 1;",
    );
    await expect(readFile(join(root, "secret.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replays a completed operation without repeating its mutation", async () => {
    const { handler, workspace, root } = await setup();
    const operationId = crypto.randomUUID();
    const payload = {
      operation: "file.write",
      workspaceId,
      path: "once.txt",
      contentBase64: Buffer.from("first").toString("base64"),
      createParents: false,
    };
    const first = await request(handler, "file.write", payload, operationId);
    await writeFile(join(workspace, "once.txt"), "changed-outside-operation");
    const restarted = await createExecutionNodeHandler({
      checkpointRoot: join(root, "checkpoints"),
      workspaces: [{ id: workspaceId, name: "Fixture", root: workspace }],
    });
    const replay = await request(restarted, "file.write", payload, operationId);
    expect(terminalValue(replay)).toEqual(terminalValue(first));
    expect(await readFile(join(workspace, "once.txt"), "utf8")).toBe("changed-outside-operation");
  });
});
