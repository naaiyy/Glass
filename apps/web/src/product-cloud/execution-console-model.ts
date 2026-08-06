import {
  decodeExecutionRequest,
  type ExecutionOperationName,
  type ExecutionRequest,
} from "@glass/contracts/execution";
import type { WorkspaceCheckpointId, WorkspaceId } from "@glass/contracts/ids";

export type ConsoleOperation = Exclude<ExecutionOperationName, "workspace.list">;

export type ExecutionConsoleFields = Readonly<{
  args: string;
  checkpointId: string;
  cols: string;
  command: string;
  content: string;
  createParents: boolean;
  cwd: string;
  data: string;
  label: string;
  path: string;
  rows: string;
  shell: string;
  staged: boolean;
  subcommand: "add" | "branch" | "checkout" | "commit" | "restore" | "switch";
  terminalId: string;
  timeoutMs: string;
}>;

export const initialExecutionConsoleFields: ExecutionConsoleFields = {
  args: "[]",
  checkpointId: "",
  cols: "100",
  command: "git",
  content: "",
  createParents: false,
  cwd: ".",
  data: "",
  label: "",
  path: ".",
  rows: "30",
  shell: "",
  staged: false,
  subcommand: "add",
  terminalId: "glass-terminal",
  timeoutMs: "120000",
};

const integer = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a whole number.`);
  return parsed;
};

const argumentsFromJson = (value: string): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Arguments must be a JSON array such as ["status", "--short"].');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Arguments must be a JSON array containing only strings.");
  }
  return parsed;
};

export const utf8ToBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
};

export const buildExecutionRequest = (
  operation: ConsoleOperation,
  workspaceId: WorkspaceId,
  fields: ExecutionConsoleFields,
): ExecutionRequest => {
  let request: ExecutionRequest;
  switch (operation) {
    case "file.list":
    case "file.read":
      request = { operation, workspaceId, path: fields.path };
      break;
    case "file.write":
      request = {
        operation,
        workspaceId,
        path: fields.path,
        contentBase64: utf8ToBase64(fields.content),
        createParents: fields.createParents,
      };
      break;
    case "command.run":
      request = {
        operation,
        workspaceId,
        command: fields.command,
        args: argumentsFromJson(fields.args),
        cwd: fields.cwd,
        timeoutMs: integer(fields.timeoutMs, "Timeout"),
      };
      break;
    case "terminal.open":
      request = {
        operation,
        workspaceId,
        terminalId: fields.terminalId,
        cwd: fields.cwd,
        cols: integer(fields.cols, "Columns"),
        rows: integer(fields.rows, "Rows"),
        shell: fields.shell.trim() === "" ? null : fields.shell,
      };
      break;
    case "terminal.input":
      request = {
        operation,
        workspaceId,
        terminalId: fields.terminalId,
        data: fields.data,
      };
      break;
    case "terminal.resize":
      request = {
        operation,
        workspaceId,
        terminalId: fields.terminalId,
        cols: integer(fields.cols, "Columns"),
        rows: integer(fields.rows, "Rows"),
      };
      break;
    case "terminal.close":
      request = { operation, workspaceId, terminalId: fields.terminalId };
      break;
    case "git.status":
      request = { operation, workspaceId };
      break;
    case "git.diff":
      request = { operation, workspaceId, staged: fields.staged };
      break;
    case "git.run":
      request = {
        operation,
        workspaceId,
        subcommand: fields.subcommand,
        args: argumentsFromJson(fields.args),
      };
      break;
    case "checkpoint.list":
      request = { operation, workspaceId };
      break;
    case "checkpoint.create":
      request = {
        operation,
        workspaceId,
        label: fields.label.trim() === "" ? null : fields.label,
      };
      break;
    case "checkpoint.restore":
      request = {
        operation,
        workspaceId,
        checkpointId: fields.checkpointId as WorkspaceCheckpointId,
      };
      break;
  }
  const decoded = decodeExecutionRequest(request);
  if (!decoded.ok) {
    throw new Error(decoded.issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "));
  }
  return decoded.value;
};
