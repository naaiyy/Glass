import type { ExecutionCapability } from "./architecture.ts";
import type { WorkspaceCheckpointId, WorkspaceId } from "./ids.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeString,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export const executionCapabilities = [
  "filesystem",
  "git",
  "processes",
  "terminals",
  "workspace-checkpoints",
] as const satisfies readonly ExecutionCapability[];

export const executionOperationNames = [
  "workspace.list",
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
  "checkpoint.restore",
] as const;

export type ExecutionOperationName = (typeof executionOperationNames)[number];

export type WorkspaceSummary = Readonly<{
  id: WorkspaceId;
  name: string;
}>;

export type FileEntry = Readonly<{
  kind: "directory" | "file" | "symlink";
  name: string;
  path: string;
  size: number;
}>;

export type CheckpointSummary = Readonly<{
  createdAt: string;
  id: WorkspaceCheckpointId;
  label: string | null;
  workspaceId: WorkspaceId;
}>;

export type ExecutionRequest =
  | Readonly<{ operation: "workspace.list" }>
  | Readonly<{ operation: "file.list"; path: string; workspaceId: WorkspaceId }>
  | Readonly<{ operation: "file.read"; path: string; workspaceId: WorkspaceId }>
  | Readonly<{
      contentBase64: string;
      createParents: boolean;
      operation: "file.write";
      path: string;
      workspaceId: WorkspaceId;
    }>
  | Readonly<{
      args: readonly string[];
      command: string;
      cwd: string;
      operation: "command.run";
      timeoutMs: number;
      workspaceId: WorkspaceId;
    }>
  | Readonly<{
      cols: number;
      cwd: string;
      operation: "terminal.open";
      rows: number;
      shell: string | null;
      terminalId: string;
      workspaceId: WorkspaceId;
    }>
  | Readonly<{
      data: string;
      operation: "terminal.input";
      terminalId: string;
      workspaceId: WorkspaceId;
    }>
  | Readonly<{
      cols: number;
      operation: "terminal.resize";
      rows: number;
      terminalId: string;
      workspaceId: WorkspaceId;
    }>
  | Readonly<{ operation: "terminal.close"; terminalId: string; workspaceId: WorkspaceId }>
  | Readonly<{ operation: "git.status"; workspaceId: WorkspaceId }>
  | Readonly<{ operation: "git.diff"; staged: boolean; workspaceId: WorkspaceId }>
  | Readonly<{
      args: readonly string[];
      operation: "git.run";
      subcommand: "add" | "branch" | "checkout" | "commit" | "restore" | "switch";
      workspaceId: WorkspaceId;
    }>
  | Readonly<{ operation: "checkpoint.list"; workspaceId: WorkspaceId }>
  | Readonly<{ label: string | null; operation: "checkpoint.create"; workspaceId: WorkspaceId }>
  | Readonly<{
      checkpointId: WorkspaceCheckpointId;
      operation: "checkpoint.restore";
      workspaceId: WorkspaceId;
    }>;

export type ExecutionProgress = Readonly<{
  data: string;
  stream: "stderr" | "stdout" | "terminal";
}>;

export type ExecutionTerminalResult = Readonly<{
  status: "succeeded";
  value: unknown;
}>;

const workspaceId = (value: unknown, path: string): DecodeResult<WorkspaceId> => {
  const decoded = decodeString(value, path, { minLength: 36, maxLength: 36 });
  return decoded.ok ? decodeSuccess(decoded.value as WorkspaceId) : decoded;
};

const pathValue = (value: unknown, path: string): DecodeResult<string> =>
  decodeString(value, path, { maxLength: 4_096 });

const booleanValue = (value: unknown, path: string): DecodeResult<boolean> =>
  typeof value === "boolean"
    ? decodeSuccess(value)
    : decodeFailure(path, "invalid_type", "Expected a boolean.");

const stringArray = (value: unknown, path: string): DecodeResult<readonly string[]> => {
  if (!Array.isArray(value) || value.length > 256) {
    return decodeFailure(path, "out_of_range", "Expected at most 256 arguments.");
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const decoded = decodeString(item, `${path}[${index}]`, { maxLength: 16_384 });
    if (!decoded.ok) return decoded;
    result.push(decoded.value);
  }
  return decodeSuccess(result);
};

const requiredValue = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): DecodeResult<unknown> =>
  Object.hasOwn(record, key)
    ? decodeSuccess(record[key])
    : decodeFailure(`$.${key}`, "missing_field", "Required field is missing.");

const field = <Value>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  decoder: (value: unknown, path: string) => DecodeResult<Value>,
): DecodeResult<Value> => {
  const value = requiredValue(record, key);
  return value.ok ? decoder(value.value, `$.${key}`) : value;
};

const failure = (result: DecodeResult<unknown>): DecodeResult<never> => {
  if (result.ok) throw new Error("Expected a failed decode result.");
  return result;
};

export const decodeExecutionRequest = (input: unknown): DecodeResult<ExecutionRequest> => {
  const recordResult = decodeRecord(input, "$");
  if (!recordResult.ok) return recordResult;
  const record = recordResult.value;
  const operation = field(record, "operation", (value, path) =>
    decodeString(value, path, { minLength: 1, maxLength: 64 }),
  );
  if (!operation.ok) return operation;
  if (!executionOperationNames.includes(operation.value as ExecutionOperationName)) {
    return decodeFailure("$.operation", "unknown_variant", "Unknown execution operation.");
  }
  const op = operation.value as ExecutionOperationName;
  if (op === "workspace.list") return decodeSuccess({ operation: op });
  if (op === "terminal.close") {
    const terminalId = field(record, "terminalId", (value, path) =>
      decodeString(value, path, { minLength: 1, maxLength: 128 }),
    );
    const workspace = field(record, "workspaceId", workspaceId);
    return terminalId.ok && workspace.ok
      ? decodeSuccess({ operation: op, terminalId: terminalId.value, workspaceId: workspace.value })
      : failure(!terminalId.ok ? terminalId : workspace);
  }
  if (op === "terminal.input") {
    const terminalId = field(record, "terminalId", (value, path) =>
      decodeString(value, path, { minLength: 1, maxLength: 128 }),
    );
    const data = field(record, "data", (value, path) =>
      decodeString(value, path, { maxLength: 65_536 }),
    );
    const workspace = field(record, "workspaceId", workspaceId);
    return terminalId.ok && workspace.ok && data.ok
      ? decodeSuccess({
          operation: op,
          terminalId: terminalId.value,
          workspaceId: workspace.value,
          data: data.value,
        })
      : failure(!terminalId.ok ? terminalId : !workspace.ok ? workspace : data);
  }
  if (op === "terminal.resize") {
    const terminalId = field(record, "terminalId", (value, path) =>
      decodeString(value, path, { minLength: 1, maxLength: 128 }),
    );
    const cols = field(record, "cols", (value, path) =>
      decodeInteger(value, path, { min: 1, max: 1_000 }),
    );
    const rows = field(record, "rows", (value, path) =>
      decodeInteger(value, path, { min: 1, max: 1_000 }),
    );
    const workspace = field(record, "workspaceId", workspaceId);
    return terminalId.ok && workspace.ok && cols.ok && rows.ok
      ? decodeSuccess({
          operation: op,
          terminalId: terminalId.value,
          workspaceId: workspace.value,
          cols: cols.value,
          rows: rows.value,
        })
      : failure(!terminalId.ok ? terminalId : !workspace.ok ? workspace : !cols.ok ? cols : rows);
  }
  const workspace = field(record, "workspaceId", workspaceId);
  if (!workspace.ok) return workspace;
  if (op === "git.status" || op === "checkpoint.list")
    return decodeSuccess({ operation: op, workspaceId: workspace.value });
  if (op === "file.list" || op === "file.read") {
    const path = field(record, "path", pathValue);
    return path.ok
      ? decodeSuccess({ operation: op, workspaceId: workspace.value, path: path.value })
      : path;
  }
  if (op === "file.write") {
    const path = field(record, "path", pathValue);
    const contentBase64 = field(record, "contentBase64", (value, location) =>
      decodeString(value, location, { maxLength: 1_500_000 }),
    );
    const createParents = field(record, "createParents", booleanValue);
    return path.ok && contentBase64.ok && createParents.ok
      ? decodeSuccess({
          operation: op,
          workspaceId: workspace.value,
          path: path.value,
          contentBase64: contentBase64.value,
          createParents: createParents.value,
        })
      : failure(!path.ok ? path : !contentBase64.ok ? contentBase64 : createParents);
  }
  if (op === "command.run") {
    const command = field(record, "command", (value, path) =>
      decodeString(value, path, { minLength: 1, maxLength: 4_096 }),
    );
    const args = field(record, "args", stringArray);
    const cwd = field(record, "cwd", pathValue);
    const timeoutMs = field(record, "timeoutMs", (value, path) =>
      decodeInteger(value, path, { min: 1, max: 600_000 }),
    );
    return command.ok && args.ok && cwd.ok && timeoutMs.ok
      ? decodeSuccess({
          operation: op,
          workspaceId: workspace.value,
          command: command.value,
          args: args.value,
          cwd: cwd.value,
          timeoutMs: timeoutMs.value,
        })
      : failure(!command.ok ? command : !args.ok ? args : !cwd.ok ? cwd : timeoutMs);
  }
  if (op === "terminal.open") {
    const terminalId = field(record, "terminalId", (value, path) =>
      decodeString(value, path, { minLength: 1, maxLength: 128 }),
    );
    const cwd = field(record, "cwd", pathValue);
    const cols = field(record, "cols", (value, path) =>
      decodeInteger(value, path, { min: 1, max: 1_000 }),
    );
    const rows = field(record, "rows", (value, path) =>
      decodeInteger(value, path, { min: 1, max: 1_000 }),
    );
    const shellValue = requiredValue(record, "shell");
    const shell =
      shellValue.ok && shellValue.value === null
        ? decodeSuccess(null)
        : shellValue.ok
          ? decodeString(shellValue.value, "$.shell", { minLength: 1, maxLength: 4_096 })
          : shellValue;
    return terminalId.ok && cwd.ok && cols.ok && rows.ok && shell.ok
      ? decodeSuccess({
          operation: op,
          workspaceId: workspace.value,
          terminalId: terminalId.value,
          cwd: cwd.value,
          cols: cols.value,
          rows: rows.value,
          shell: shell.value,
        })
      : failure(
          !terminalId.ok ? terminalId : !cwd.ok ? cwd : !cols.ok ? cols : !rows.ok ? rows : shell,
        );
  }
  if (op === "git.diff") {
    const staged = field(record, "staged", booleanValue);
    return staged.ok
      ? decodeSuccess({ operation: op, workspaceId: workspace.value, staged: staged.value })
      : staged;
  }
  if (op === "git.run") {
    const subcommand = field(
      record,
      "subcommand",
      (
        value,
        path,
      ): DecodeResult<"add" | "branch" | "checkout" | "commit" | "restore" | "switch"> =>
        typeof value === "string" &&
        ["add", "branch", "checkout", "commit", "restore", "switch"].includes(value)
          ? decodeSuccess(value as "add" | "branch" | "checkout" | "commit" | "restore" | "switch")
          : decodeFailure(path, "unknown_variant", "Unsupported Git operation."),
    );
    const args = field(record, "args", stringArray);
    return subcommand.ok && args.ok
      ? decodeSuccess({
          operation: op,
          workspaceId: workspace.value,
          subcommand: subcommand.value,
          args: args.value,
        })
      : failure(!subcommand.ok ? subcommand : args);
  }
  if (op === "checkpoint.create") {
    const raw = requiredValue(record, "label");
    const label =
      raw.ok && raw.value === null
        ? decodeSuccess(null)
        : raw.ok
          ? decodeString(raw.value, "$.label", { minLength: 1, maxLength: 200 })
          : raw;
    return label.ok
      ? decodeSuccess({ operation: op, workspaceId: workspace.value, label: label.value })
      : label;
  }
  const checkpointId = field(record, "checkpointId", (value, path) => {
    const decoded = decodeString(value, path, { minLength: 36, maxLength: 36 });
    return decoded.ok ? decodeSuccess(decoded.value as WorkspaceCheckpointId) : decoded;
  });
  return checkpointId.ok
    ? decodeSuccess({
        operation: "checkpoint.restore",
        workspaceId: workspace.value,
        checkpointId: checkpointId.value,
      })
    : checkpointId;
};
