import { decodeExecutionRequest, type ExecutionRequest } from "@glass/contracts/execution";
import type { WorkspaceId } from "@glass/contracts/ids";

export type MobileExecutionKind = ExecutionRequest["operation"];

export type MobileExecutionDraft = Readonly<{
  args: string;
  checkpointId: string;
  checkpointLabel: string;
  cols: string;
  command: string;
  content: string;
  createParents: boolean;
  cwd: string;
  data: string;
  gitStaged: boolean;
  gitSubcommand: "add" | "branch" | "checkout" | "commit" | "restore" | "switch";
  operation: MobileExecutionKind;
  path: string;
  rows: string;
  shell: string;
  terminalId: string;
  timeoutMs: string;
}>;

export const defaultMobileExecutionDraft: MobileExecutionDraft = {
  args: "",
  checkpointId: "",
  checkpointLabel: "",
  cols: "80",
  command: "pwd",
  content: "",
  createParents: false,
  cwd: ".",
  data: "",
  gitStaged: false,
  gitSubcommand: "branch",
  operation: "file.list",
  path: ".",
  rows: "24",
  shell: "",
  terminalId: "mobile-terminal",
  timeoutMs: "60000",
};

export const mobileExecutionOperations = [
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
] as const satisfies readonly MobileExecutionKind[];

const integer = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a whole number.`);
  return parsed;
};

const lines = (value: string): readonly string[] =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

const utf8Base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const buildMobileExecutionRequest = (
  draft: MobileExecutionDraft,
  workspaceId: WorkspaceId,
): ExecutionRequest => {
  let request: ExecutionRequest;
  switch (draft.operation) {
    case "workspace.list":
      request = { operation: "workspace.list" };
      break;
    case "file.list":
    case "file.read":
      request = { operation: draft.operation, path: draft.path, workspaceId };
      break;
    case "file.write":
      request = {
        operation: "file.write",
        contentBase64: utf8Base64(draft.content),
        createParents: draft.createParents,
        path: draft.path,
        workspaceId,
      };
      break;
    case "command.run":
      request = {
        operation: "command.run",
        args: lines(draft.args),
        command: draft.command,
        cwd: draft.cwd,
        timeoutMs: integer(draft.timeoutMs, "Timeout"),
        workspaceId,
      };
      break;
    case "terminal.open":
      request = {
        operation: "terminal.open",
        cols: integer(draft.cols, "Columns"),
        cwd: draft.cwd,
        rows: integer(draft.rows, "Rows"),
        shell: draft.shell.trim() || null,
        terminalId: draft.terminalId,
        workspaceId,
      };
      break;
    case "terminal.input":
      request = {
        operation: "terminal.input",
        data: draft.data,
        terminalId: draft.terminalId,
        workspaceId,
      };
      break;
    case "terminal.resize":
      request = {
        operation: "terminal.resize",
        cols: integer(draft.cols, "Columns"),
        rows: integer(draft.rows, "Rows"),
        terminalId: draft.terminalId,
        workspaceId,
      };
      break;
    case "terminal.close":
      request = { operation: "terminal.close", terminalId: draft.terminalId, workspaceId };
      break;
    case "git.status":
      request = { operation: "git.status", workspaceId };
      break;
    case "git.diff":
      request = { operation: "git.diff", staged: draft.gitStaged, workspaceId };
      break;
    case "git.run":
      request = {
        operation: "git.run",
        args: lines(draft.args),
        subcommand: draft.gitSubcommand,
        workspaceId,
      };
      break;
    case "checkpoint.list":
      request = { operation: "checkpoint.list", workspaceId };
      break;
    case "checkpoint.create":
      request = {
        operation: "checkpoint.create",
        label: draft.checkpointLabel.trim() || null,
        workspaceId,
      };
      break;
    case "checkpoint.restore":
      request = {
        operation: "checkpoint.restore",
        checkpointId: draft.checkpointId as never,
        workspaceId,
      };
      break;
  }
  const decoded = decodeExecutionRequest(request);
  if (!decoded.ok) throw new Error("The execution fields are invalid for this operation.");
  return decoded.value;
};
