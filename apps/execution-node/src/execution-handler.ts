import type { BoundaryError, BoundaryErrorCode } from "@glass/contracts/errors";
import { decodeConnectNodeFrame, type ConnectNodeFrame } from "@glass/contracts/connect";
import {
  decodeExecutionRequest,
  type CheckpointSummary,
  type ExecutionProgress,
  type ExecutionRequest,
  type FileEntry,
  type WorkspaceSummary,
} from "@glass/contracts/execution";
import type { WorkspaceCheckpointId, WorkspaceId } from "@glass/contracts/ids";
import { readyExecutionDescriptor } from "@glass/execution-core/capabilities";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnTerminal, type IPty } from "node-pty";
import * as tar from "tar";
import type { ConnectNodeHandler } from "./connect.ts";

const maxFileBytes = 512 * 1_024;
const maxDirectoryEntries = 1_000;
const maxOperationOutputBytes = 10 * 1_024 * 1_024;
const maxCheckpointBytes = 2 * 1_024 * 1_024 * 1_024;
const maxCheckpointEntries = 100_000;
const require = createRequire(import.meta.url);

const ensurePtyHelperExecutable = async (): Promise<void> => {
  if (process.platform === "win32") return;
  const packageRoot = dirname(dirname(require.resolve("node-pty")));
  const candidates = [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- candidates are fallbacks and stop at the first installed helper.
      await chmod(candidate, 0o755);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
};

type RegisteredWorkspace = Readonly<{
  id: WorkspaceId;
  name: string;
  root: string;
}>;

export type ExecutionNodeWorkspace = Readonly<{
  id: WorkspaceId;
  name: string;
  root: string;
}>;

export type ExecutionNodeHandlerOptions = Readonly<{
  checkpointRoot: string;
  workspaces: readonly ExecutionNodeWorkspace[];
}>;

class ExecutionFault extends Error {
  readonly code: BoundaryErrorCode;
  readonly retryable: boolean;

  constructor(code: BoundaryErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const boundaryError = (error: unknown): BoundaryError =>
  error instanceof ExecutionFault
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "EXECUTION_FAILED", message: "The execution operation failed.", retryable: false };

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const assertRelativePath = (path: string): void => {
  if (path.includes("\0") || isAbsolute(path)) {
    throw new ExecutionFault("VALIDATION_FAILED", "Workspace paths must be relative.");
  }
};

const resolveSafePath = async (
  workspace: RegisteredWorkspace,
  input: string,
  options: Readonly<{ allowMissingLeaf?: boolean }> = {},
): Promise<string> => {
  assertRelativePath(input);
  const candidate = resolve(workspace.root, input || ".");
  if (!isWithin(workspace.root, candidate)) {
    throw new ExecutionFault("FORBIDDEN", "Path escapes the registered workspace.");
  }
  const components = relative(workspace.root, candidate).split(sep).filter(Boolean);
  let current = workspace.root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    try {
      // eslint-disable-next-line no-await-in-loop -- every path component must be checked in traversal order.
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ExecutionFault(
          "FORBIDDEN",
          "Symbolic links are not followed by execution operations.",
        );
      }
    } catch (error) {
      if (
        options.allowMissingLeaf === true &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (index < components.length - 1) {
          // Missing parents are permitted only for atomic file.write with createParents.
          return candidate;
        }
        return candidate;
      }
      throw error;
    }
  }
  const canonical = await realpath(candidate);
  if (!isWithin(workspace.root, canonical)) {
    throw new ExecutionFault("FORBIDDEN", "Resolved path escapes the registered workspace.");
  }
  return canonical;
};

const runChild = async (
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  timeoutMs: number,
  emit: (progress: ExecutionProgress) => void,
): Promise<Readonly<{ exitCode: number; signal: string | null }>> => {
  let outputBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | null = null;
  const signalProcessTree = (processSignal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, processSignal);
        return;
      } catch {
        // Fall through when the child exited between observation and signalling.
      }
    }
    child.kill(processSignal);
  };
  const terminate = (): void => {
    signalProcessTree("SIGTERM");
    if (killEscalation !== null) return;
    killEscalation = setTimeout(() => signalProcessTree("SIGKILL"), 1_000);
    killEscalation.unref?.();
  };
  const publish = (stream: "stderr" | "stdout", data: Buffer): void => {
    outputBytes += data.byteLength;
    if (outputBytes > maxOperationOutputBytes) {
      outputExceeded = true;
      terminate();
      return;
    }
    emit({ stream, data: data.toString("utf8") });
  };
  child.stdout.on("data", (data: Buffer) => publish("stdout", data));
  child.stderr.on("data", (data: Buffer) => publish("stderr", data));
  const onAbort = (): void => {
    terminate();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  try {
    const result = await new Promise<Readonly<{ exitCode: number; signal: string | null }>>(
      (complete, reject) => {
        child.once("error", reject);
        child.once("close", (code, processSignal) =>
          complete({ exitCode: code ?? -1, signal: processSignal }),
        );
      },
    );
    if (signal.aborted) throw new ExecutionFault("EXECUTION_CANCELLED", "Operation cancelled.");
    if (timedOut) throw new ExecutionFault("TIMEOUT", "Operation timed out.");
    if (outputExceeded) {
      throw new ExecutionFault("EXECUTION_FAILED", "Operation output exceeded its bound.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
    if (killEscalation !== null) clearTimeout(killEscalation);
    signal.removeEventListener("abort", onAbort);
  }
};

class ExecutionRuntime {
  readonly checkpoints: string;
  readonly workspaces: ReadonlyMap<string, RegisteredWorkspace>;
  readonly active = new Map<string, AbortController>();
  readonly terminals = new Map<string, Readonly<{ terminal: IPty; workspaceId: WorkspaceId }>>();

  private constructor(checkpoints: string, workspaces: ReadonlyMap<string, RegisteredWorkspace>) {
    this.checkpoints = checkpoints;
    this.workspaces = workspaces;
  }

  static async create(options: ExecutionNodeHandlerOptions): Promise<ExecutionRuntime> {
    const checkpoints = resolve(options.checkpointRoot);
    await mkdir(checkpoints, { recursive: true, mode: 0o700 });
    const registered = new Map<string, RegisteredWorkspace>();
    for (const workspace of options.workspaces) {
      if (registered.has(workspace.id)) {
        throw new ExecutionFault(
          "CONFLICT",
          `Workspace ID is registered more than once: ${workspace.id}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- registration validates each workspace before admitting the next.
      const root = await realpath(resolve(workspace.root));
      // eslint-disable-next-line no-await-in-loop -- the resolved root must be classified before registration.
      const metadata = await stat(root);
      if (!metadata.isDirectory())
        throw new ExecutionFault("VALIDATION_FAILED", "Workspace root is not a directory.");
      registered.set(workspace.id, { id: workspace.id, name: workspace.name, root });
    }
    return new ExecutionRuntime(checkpoints, registered);
  }

  workspace(id: WorkspaceId): RegisteredWorkspace {
    const workspace = this.workspaces.get(id);
    if (!workspace)
      throw new ExecutionFault("NOT_FOUND", "Workspace is not registered on this environment.");
    return workspace;
  }

  cancel(operationId: string): boolean {
    const operation = this.active.get(operationId);
    if (operation === undefined) return false;
    operation.abort();
    return true;
  }

  async execute(
    operationId: string,
    request: ExecutionRequest,
    emit: (progress: ExecutionProgress) => void,
  ): Promise<unknown> {
    if (this.active.has(operationId))
      throw new ExecutionFault("CONFLICT", "Operation is already active.");
    const controller = new AbortController();
    this.active.set(operationId, controller);
    try {
      return await this.perform(request, controller.signal, emit);
    } finally {
      this.active.delete(operationId);
    }
  }

  private async perform(
    request: ExecutionRequest,
    signal: AbortSignal,
    emit: (progress: ExecutionProgress) => void,
  ): Promise<unknown> {
    if (request.operation === "workspace.list") {
      return {
        descriptor: readyExecutionDescriptor(),
        workspaces: [...this.workspaces.values()].map(
          ({ id, name }): WorkspaceSummary => ({ id, name }),
        ),
      };
    }
    if (request.operation === "terminal.input") {
      this.workspace(request.workspaceId);
      const entry = this.terminals.get(request.terminalId);
      if (!entry) throw new ExecutionFault("NOT_FOUND", "Terminal does not exist.");
      if (entry.workspaceId !== request.workspaceId)
        throw new ExecutionFault("FORBIDDEN", "Terminal belongs to another workspace.");
      entry.terminal.write(request.data);
      return { accepted: true };
    }
    if (request.operation === "terminal.resize") {
      this.workspace(request.workspaceId);
      const entry = this.terminals.get(request.terminalId);
      if (!entry) throw new ExecutionFault("NOT_FOUND", "Terminal does not exist.");
      if (entry.workspaceId !== request.workspaceId)
        throw new ExecutionFault("FORBIDDEN", "Terminal belongs to another workspace.");
      entry.terminal.resize(request.cols, request.rows);
      return { resized: true };
    }
    if (request.operation === "terminal.close") {
      this.workspace(request.workspaceId);
      const entry = this.terminals.get(request.terminalId);
      if (!entry) return { closed: false };
      if (entry.workspaceId !== request.workspaceId)
        throw new ExecutionFault("FORBIDDEN", "Terminal belongs to another workspace.");
      entry.terminal.kill();
      this.terminals.delete(request.terminalId);
      return { closed: true };
    }
    const workspace = this.workspace(request.workspaceId);
    if (request.operation === "file.list") {
      const directory = await resolveSafePath(workspace, request.path);
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.length > maxDirectoryEntries) {
        throw new ExecutionFault("EXECUTION_FAILED", "Directory exceeds the listing bound.");
      }
      return Promise.all(
        entries.map(async (entry): Promise<FileEntry> => {
          const child = join(directory, entry.name);
          const metadata = await lstat(child);
          return {
            kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file",
            name: entry.name,
            path: relative(workspace.root, child),
            size: metadata.size,
          };
        }),
      );
    }
    if (request.operation === "file.read") {
      const file = await resolveSafePath(workspace, request.path);
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new ExecutionFault("VALIDATION_FAILED", "Path is not a file.");
      if (metadata.size > maxFileBytes)
        throw new ExecutionFault("EXECUTION_FAILED", "File exceeds the read bound.");
      return { contentBase64: (await readFile(file)).toString("base64"), size: metadata.size };
    }
    if (request.operation === "file.write") {
      const decoded = Buffer.from(request.contentBase64, "base64");
      if (
        decoded.byteLength > maxFileBytes ||
        decoded.toString("base64") !== request.contentBase64.replace(/\n/gu, "")
      ) {
        throw new ExecutionFault(
          "VALIDATION_FAILED",
          "File content is invalid or exceeds the write bound.",
        );
      }
      const file = await resolveSafePath(workspace, request.path, { allowMissingLeaf: true });
      const parent = dirname(file);
      if (request.createParents) await mkdir(parent, { recursive: true });
      await resolveSafePath(workspace, relative(workspace.root, parent));
      try {
        const existing = await lstat(file);
        if (existing.isSymbolicLink() || existing.isDirectory())
          throw new ExecutionFault("FORBIDDEN", "Write target is not a regular file.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const temporary = join(parent, `.glass-write-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(decoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      return { size: decoded.byteLength };
    }
    if (request.operation === "command.run") {
      const cwd = await resolveSafePath(workspace, request.cwd);
      const child = spawnProcess(request.command, [...request.args], {
        cwd,
        env: process.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
      return runChild(child, signal, request.timeoutMs, emit);
    }
    if (request.operation === "terminal.open") {
      if (this.terminals.has(request.terminalId))
        throw new ExecutionFault("CONFLICT", "Terminal already exists.");
      const cwd = await resolveSafePath(workspace, request.cwd);
      const shell = request.shell ?? process.env.SHELL ?? "/bin/sh";
      if (!isAbsolute(shell))
        throw new ExecutionFault("VALIDATION_FAILED", "Terminal shell must be an absolute path.");
      await ensurePtyHelperExecutable();
      const terminal = spawnTerminal(shell, [], {
        cols: request.cols,
        rows: request.rows,
        cwd,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        name: "xterm-256color",
      });
      let outputBytes = 0;
      terminal.onData((data) => {
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > maxOperationOutputBytes) {
          terminal.kill();
          this.terminals.delete(request.terminalId);
          return;
        }
        emit({ stream: "terminal", data });
      });
      this.terminals.set(request.terminalId, { terminal, workspaceId: request.workspaceId });
      const onAbort = (): void => terminal.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const exited = await new Promise<Readonly<{ exitCode: number; signal?: number }>>(
          (complete) => {
            terminal.onExit((event) => complete(event));
          },
        );
        if (signal.aborted)
          throw new ExecutionFault("EXECUTION_CANCELLED", "Terminal operation cancelled.");
        return { ...exited, terminalId: request.terminalId };
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.terminals.delete(request.terminalId);
      }
    }
    if (
      request.operation === "git.status" ||
      request.operation === "git.diff" ||
      request.operation === "git.run"
    ) {
      const args =
        request.operation === "git.status"
          ? ["status", "--porcelain=v2", "--branch"]
          : request.operation === "git.diff"
            ? ["diff", ...(request.staged ? ["--cached"] : []), "--"]
            : [request.subcommand, ...request.args];
      const child = spawnProcess("git", args, {
        cwd: workspace.root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
      return runChild(child, signal, 120_000, emit);
    }
    if (request.operation === "checkpoint.list") return this.listCheckpoints(workspace.id);
    if (request.operation === "checkpoint.create")
      return this.createCheckpoint(workspace, request.label);
    return this.restoreCheckpoint(workspace, request.checkpointId);
  }

  private checkpointDirectory(workspaceId: WorkspaceId): string {
    return join(this.checkpoints, workspaceId);
  }

  private async listCheckpoints(workspaceId: WorkspaceId): Promise<readonly CheckpointSummary[]> {
    const directory = this.checkpointDirectory(workspaceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory);
    const summaries: CheckpointSummary[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).slice(0, 1_000)) {
      // eslint-disable-next-line no-await-in-loop -- checkpoint metadata is bounded and decoded independently.
      const parsed = JSON.parse(await readFile(join(directory, entry), "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "id" in parsed &&
        "createdAt" in parsed &&
        "workspaceId" in parsed &&
        "label" in parsed
      ) {
        summaries.push(parsed as CheckpointSummary);
      }
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async inspectCheckpointSource(root: string): Promise<void> {
    let entries = 0;
    let bytes = 0;
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      // eslint-disable-next-line no-await-in-loop -- directory traversal is intentionally bounded and sequential.
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > maxCheckpointEntries)
          throw new ExecutionFault(
            "EXECUTION_FAILED",
            "Workspace exceeds the checkpoint entry bound.",
          );
        const target = join(directory, entry.name);
        // eslint-disable-next-line no-await-in-loop -- each entry is inspected before it can extend the traversal.
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink())
          throw new ExecutionFault("FORBIDDEN", "Checkpoints do not follow symbolic links.");
        bytes += metadata.size;
        if (bytes > maxCheckpointBytes)
          throw new ExecutionFault(
            "EXECUTION_FAILED",
            "Workspace exceeds the checkpoint size bound.",
          );
        if (metadata.isDirectory()) pending.push(target);
      }
    }
  }

  private async createCheckpoint(
    workspace: RegisteredWorkspace,
    label: string | null,
  ): Promise<CheckpointSummary> {
    await this.inspectCheckpointSource(workspace.root);
    const id = randomUUID() as WorkspaceCheckpointId;
    const directory = this.checkpointDirectory(workspace.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = join(directory, `${id}.tar.gz`);
    await tar.create({ cwd: workspace.root, file: archive, gzip: true, portable: true }, ["."]);
    const summary: CheckpointSummary = {
      id,
      workspaceId: workspace.id,
      label,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(directory, `${id}.json`), JSON.stringify(summary), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return summary;
  }

  private async restoreCheckpoint(
    workspace: RegisteredWorkspace,
    id: WorkspaceCheckpointId,
  ): Promise<CheckpointSummary> {
    const directory = this.checkpointDirectory(workspace.id);
    const archive = join(directory, `${id}.tar.gz`);
    const summary = JSON.parse(
      await readFile(join(directory, `${id}.json`), "utf8"),
    ) as CheckpointSummary;
    await stat(archive);
    const rollback = join(dirname(workspace.root), `.glass-rollback-${randomUUID()}`);
    await mkdir(rollback, { mode: 0o700 });
    const existing = await readdir(workspace.root);
    try {
      for (const entry of existing) {
        // eslint-disable-next-line no-await-in-loop -- rollback moves are ordered to preserve recoverability.
        await rename(join(workspace.root, entry), join(rollback, entry));
      }
      try {
        await tar.extract({ cwd: workspace.root, file: archive, strict: true });
      } catch (error) {
        for (const entry of await readdir(workspace.root)) {
          // eslint-disable-next-line no-await-in-loop -- rollback cleanup must finish before restoring entries.
          await rm(join(workspace.root, entry), { recursive: true, force: true });
        }
        for (const entry of await readdir(rollback)) {
          // eslint-disable-next-line no-await-in-loop -- restore moves are ordered to preserve recoverability.
          await rename(join(rollback, entry), join(workspace.root, entry));
        }
        throw error;
      }
      await rm(rollback, { recursive: true, force: true });
      return summary;
    } catch (error) {
      await rm(rollback, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

type OperationJournalEntry = Readonly<{
  fingerprint: string;
  frame: ConnectNodeFrame | null;
  operationId: string;
  state: "started" | "terminal";
}>;

const operationJournalDirectory = (stateRoot: string): string => join(stateRoot, "operations");
const operationJournalPath = (stateRoot: string, operationId: string): string =>
  join(
    operationJournalDirectory(stateRoot),
    `${createHash("sha256").update(operationId).digest("hex")}.json`,
  );

const operationJournalEntryExists = async (
  stateRoot: string,
  operationId: string,
): Promise<boolean> => {
  try {
    await lstat(operationJournalPath(stateRoot, operationId));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

const persistJournalEntry = async (
  stateRoot: string,
  entry: OperationJournalEntry,
): Promise<void> => {
  const directory = operationJournalDirectory(stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = operationJournalPath(stateRoot, entry.operationId);
  const temporary = join(directory, `.glass-operation-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(entry));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  if (entry.state === "terminal") {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    if (files.length > 1_000) {
      const dated = await Promise.all(
        files.map(async (file) => ({
          file,
          modified: (await stat(join(directory, file))).mtimeMs,
        })),
      );
      dated.sort((left, right) => left.modified - right.modified);
      await Promise.all(
        dated
          .slice(0, dated.length - 1_000)
          .map(({ file }) => rm(join(directory, file), { force: true })),
      );
    }
  }
};

const loadOperationJournal = async (
  stateRoot: string,
): Promise<Map<string, Readonly<{ fingerprint: string; frames: readonly ConnectNodeFrame[] }>>> => {
  const directory = operationJournalDirectory(stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).slice(-1_000);
  const completed = new Map<
    string,
    Readonly<{ fingerprint: string; frames: readonly ConnectNodeFrame[] }>
  >();
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the bounded journal is validated entry by entry.
      const parsed = JSON.parse(await readFile(join(directory, file), "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("operationId" in parsed) ||
        !("fingerprint" in parsed) ||
        !("state" in parsed)
      )
        continue;
      if (typeof parsed.operationId !== "string" || typeof parsed.fingerprint !== "string")
        continue;
      if (parsed.state === "terminal" && "frame" in parsed) {
        const decoded = decodeConnectNodeFrame(parsed.frame);
        if (decoded.ok)
          completed.set(parsed.operationId, {
            fingerprint: parsed.fingerprint,
            frames: [decoded.value],
          });
      } else if (parsed.state === "started") {
        completed.set(parsed.operationId, {
          fingerprint: parsed.fingerprint,
          frames: [
            {
              type: "operation.error",
              operationId: parsed.operationId,
              requestId: "recovered-operation",
              error: {
                code: "EXECUTION_FAILED",
                message:
                  "The node restarted before this operation recorded its outcome; Glass will not run it again.",
                retryable: false,
              },
            },
          ],
        });
      }
    } catch {
      // A corrupt journal entry is ignored because its hashed file cannot safely identify an operation.
    }
  }
  return completed;
};

export const createExecutionNodeHandler = async (
  options: ExecutionNodeHandlerOptions,
): Promise<ConnectNodeHandler> => {
  const runtime = await ExecutionRuntime.create(options);
  const completed = await loadOperationJournal(runtime.checkpoints);
  const inFlight = new Map<string, string>();
  return async (dispatch, reply) => {
    const frame = dispatch.frame;
    if (frame.type === "operation.cancel") {
      if (runtime.cancel(frame.operationId)) return;
      reply({
        type: "relay.reply",
        channelId: dispatch.channelId,
        frame: {
          type: "operation.error",
          requestId: frame.requestId,
          operationId: frame.operationId,
          error: {
            code: "EXECUTION_CANCELLED",
            message: "The operation is not active on this node and is terminally cancelled.",
            retryable: false,
          },
        },
      });
      return;
    }
    const decoded = decodeExecutionRequest(frame.payload);
    if (!decoded.ok || decoded.value.operation !== frame.capability) {
      reply({
        type: "relay.reply",
        channelId: dispatch.channelId,
        frame: {
          type: "operation.error",
          requestId: frame.requestId,
          operationId: frame.operationId,
          error: {
            code: "VALIDATION_FAILED",
            message: decoded.ok
              ? "Capability does not match the typed execution payload."
              : decoded.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "),
            retryable: false,
          },
        },
      });
      return;
    }
    const fingerprint = JSON.stringify([frame.capability, decoded.value]);
    const cached = completed.get(frame.operationId);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        reply({
          type: "relay.reply",
          channelId: dispatch.channelId,
          frame: {
            type: "operation.error",
            requestId: frame.requestId,
            operationId: frame.operationId,
            error: {
              code: "CONFLICT",
              message: "Operation ID was already used for a different request.",
              retryable: false,
            },
          },
        });
        return;
      }
      for (const cachedFrame of cached.frames) {
        reply({
          type: "relay.reply",
          channelId: dispatch.channelId,
          frame: { ...cachedFrame, requestId: frame.requestId },
        });
      }
      return;
    }
    const activeFingerprint = inFlight.get(frame.operationId);
    if (activeFingerprint !== undefined) {
      reply({
        type: "relay.reply",
        channelId: dispatch.channelId,
        frame: {
          type: "operation.error",
          requestId: frame.requestId,
          operationId: frame.operationId,
          error: {
            code: "CONFLICT",
            message:
              activeFingerprint === fingerprint
                ? "Operation is still in progress."
                : "Operation ID is active for a different request.",
            retryable: activeFingerprint === fingerprint,
          },
        },
      });
      return;
    }
    inFlight.set(frame.operationId, fingerprint);
    const recorded: ConnectNodeFrame[] = [];
    let sequence = 0;
    const send = (event: "progress" | "result", payload: unknown): void => {
      const outgoing: ConnectNodeFrame = {
        type: "operation.event",
        requestId: frame.requestId,
        operationId: frame.operationId,
        event,
        sequence: sequence++,
        payload,
      };
      recorded.push(outgoing);
      reply({
        type: "relay.reply",
        channelId: dispatch.channelId,
        frame: outgoing,
      });
    };
    try {
      if (await operationJournalEntryExists(runtime.checkpoints, frame.operationId)) {
        throw new ExecutionFault(
          "EXECUTION_FAILED",
          "An unreadable durable record already exists for this operation; Glass will not run it again.",
        );
      }
      await persistJournalEntry(runtime.checkpoints, {
        operationId: frame.operationId,
        fingerprint,
        state: "started",
        frame: null,
      });
      const result = await runtime.execute(frame.operationId, decoded.value, (progress) =>
        send("progress", progress),
      );
      const outgoing: ConnectNodeFrame = {
        type: "operation.event",
        requestId: frame.requestId,
        operationId: frame.operationId,
        event: "result",
        sequence: sequence++,
        payload: { status: "succeeded", value: result },
      };
      await persistJournalEntry(runtime.checkpoints, {
        operationId: frame.operationId,
        fingerprint,
        state: "terminal",
        frame: outgoing,
      });
      recorded.push(outgoing);
      reply({ type: "relay.reply", channelId: dispatch.channelId, frame: outgoing });
    } catch (error) {
      const outgoing: ConnectNodeFrame = {
        type: "operation.error",
        requestId: frame.requestId,
        operationId: frame.operationId,
        error: boundaryError(error),
      };
      await persistJournalEntry(runtime.checkpoints, {
        operationId: frame.operationId,
        fingerprint,
        state: "terminal",
        frame: outgoing,
      });
      recorded.push(outgoing);
      reply({
        type: "relay.reply",
        channelId: dispatch.channelId,
        frame: outgoing,
      });
    } finally {
      inFlight.delete(frame.operationId);
      completed.set(frame.operationId, {
        fingerprint,
        frames: recorded.filter(
          (entry) => entry.type === "operation.error" || entry.event === "result",
        ),
      });
      if (completed.size > 1_000) {
        const oldest = completed.keys().next().value;
        if (oldest !== undefined) completed.delete(oldest);
      }
    }
  };
};
