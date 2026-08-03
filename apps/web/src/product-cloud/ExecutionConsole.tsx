import type { ExecutionRequest } from "@glass/contracts/execution";
import type { ExecutionOperation } from "@glass/contracts/execution-cloud";
import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";
import { useState, type FormEvent } from "react";

import {
  buildExecutionRequest,
  initialExecutionConsoleFields,
  type ConsoleOperation,
  type ExecutionConsoleFields,
} from "./execution-console-model.ts";

const choices: readonly Readonly<{ label: string; operations: readonly ConsoleOperation[] }>[] = [
  { label: "Files", operations: ["file.list", "file.read", "file.write"] },
  { label: "Commands", operations: ["command.run"] },
  {
    label: "Terminal",
    operations: ["terminal.open", "terminal.input", "terminal.resize", "terminal.close"],
  },
  { label: "Git", operations: ["git.status", "git.diff", "git.run"] },
  {
    label: "Checkpoints",
    operations: ["checkpoint.list", "checkpoint.create", "checkpoint.restore"],
  },
];

const isActive = (operation: ExecutionOperation): boolean =>
  operation.status === "queued" ||
  operation.status === "running" ||
  operation.status === "cancelling";

const payloadText = (value: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    return value.data;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
};

export const ExecutionConsole = ({
  binding,
  environmentName,
  online,
  onCancel,
  onRun,
  operations,
}: {
  binding: WorkspaceBinding;
  environmentName: string;
  online: boolean;
  onCancel: (operation: ExecutionOperation) => Promise<void>;
  onRun: (request: ExecutionRequest) => Promise<void>;
  operations: readonly ExecutionOperation[];
}) => {
  const [operation, setOperation] = useState<ConsoleOperation>("file.list");
  const [fields, setFields] = useState<ExecutionConsoleFields>(initialExecutionConsoleFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <Key extends keyof ExecutionConsoleFields>(
    key: Key,
    value: ExecutionConsoleFields[Key],
  ) => setFields((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onRun(buildExecutionRequest(operation, binding.id, fields));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Execution request failed.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (item: ExecutionOperation) => {
    setError(null);
    try {
      await onCancel(item);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed.");
    }
  };

  const hasPath =
    operation === "file.list" || operation === "file.read" || operation === "file.write";
  const hasTerminal = operation.startsWith("terminal.");
  const hasDimensions = operation === "terminal.open" || operation === "terminal.resize";
  const hasArguments = operation === "command.run" || operation === "git.run";

  return (
    <section className="execution-console" aria-label="Execution console">
      <header>
        <div>
          <h3>Execution console</h3>
          <p>
            {environmentName} · {binding.displayName}
          </p>
          <small>
            Environment {binding.environmentId} · Workspace {binding.id}
          </small>
        </div>
        <span className={online ? "execution-online" : "execution-offline"}>
          {online ? "Connected" : "Reconnecting"}
        </span>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="execution-operation">Capability</label>
        <select
          id="execution-operation"
          value={operation}
          onChange={(event) => setOperation(event.target.value as ConsoleOperation)}
        >
          {choices.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.operations.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {hasPath ? (
          <label>
            Workspace-relative path
            <input value={fields.path} onChange={(event) => update("path", event.target.value)} />
          </label>
        ) : null}
        {operation === "file.write" ? (
          <>
            <label>
              UTF-8 file content
              <textarea
                rows={6}
                value={fields.content}
                onChange={(event) => update("content", event.target.value)}
              />
            </label>
            <label className="execution-check">
              <input
                type="checkbox"
                checked={fields.createParents}
                onChange={(event) => update("createParents", event.target.checked)}
              />
              Create parent directories
            </label>
          </>
        ) : null}
        {operation === "command.run" ? (
          <label>
            Executable (no shell expansion)
            <input
              value={fields.command}
              onChange={(event) => update("command", event.target.value)}
            />
          </label>
        ) : null}
        {operation === "command.run" || operation === "terminal.open" ? (
          <label>
            Workspace-relative working directory
            <input value={fields.cwd} onChange={(event) => update("cwd", event.target.value)} />
          </label>
        ) : null}
        {hasArguments ? (
          <label>
            Arguments (JSON string array)
            <input value={fields.args} onChange={(event) => update("args", event.target.value)} />
          </label>
        ) : null}
        {operation === "command.run" ? (
          <label>
            Timeout (milliseconds)
            <input
              inputMode="numeric"
              value={fields.timeoutMs}
              onChange={(event) => update("timeoutMs", event.target.value)}
            />
          </label>
        ) : null}
        {hasTerminal ? (
          <label>
            Terminal ID
            <input
              value={fields.terminalId}
              onChange={(event) => update("terminalId", event.target.value)}
            />
          </label>
        ) : null}
        {operation === "terminal.open" ? (
          <label>
            Shell (blank uses the environment default)
            <input value={fields.shell} onChange={(event) => update("shell", event.target.value)} />
          </label>
        ) : null}
        {operation === "terminal.input" ? (
          <label>
            Terminal input
            <textarea
              rows={3}
              value={fields.data}
              onChange={(event) => update("data", event.target.value)}
            />
          </label>
        ) : null}
        {hasDimensions ? (
          <div className="execution-row">
            <label>
              Columns
              <input value={fields.cols} onChange={(event) => update("cols", event.target.value)} />
            </label>
            <label>
              Rows
              <input value={fields.rows} onChange={(event) => update("rows", event.target.value)} />
            </label>
          </div>
        ) : null}
        {operation === "git.diff" ? (
          <label className="execution-check">
            <input
              type="checkbox"
              checked={fields.staged}
              onChange={(event) => update("staged", event.target.checked)}
            />
            Show staged changes
          </label>
        ) : null}
        {operation === "git.run" ? (
          <label>
            Allowed Git subcommand
            <select
              value={fields.subcommand}
              onChange={(event) =>
                update("subcommand", event.target.value as ExecutionConsoleFields["subcommand"])
              }
            >
              {(["add", "branch", "checkout", "commit", "restore", "switch"] as const).map(
                (name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ),
              )}
            </select>
          </label>
        ) : null}
        {operation === "checkpoint.create" ? (
          <label>
            Checkpoint label (optional)
            <input value={fields.label} onChange={(event) => update("label", event.target.value)} />
          </label>
        ) : null}
        {operation === "checkpoint.restore" ? (
          <label>
            Checkpoint ID
            <input
              value={fields.checkpointId}
              onChange={(event) => update("checkpointId", event.target.value)}
            />
          </label>
        ) : null}
        {error === null ? null : (
          <p className="execution-error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy || !online} type="submit">
          {busy ? "Creating durable operation…" : `Run ${operation}`}
        </button>
      </form>

      <div className="execution-history" aria-live="polite">
        <h4>Durable operations</h4>
        {operations.length === 0 ? <p>No operations have run in this connection.</p> : null}
        {operations.map((item) => (
          <article key={item.operationId} className="execution-operation">
            <header>
              <strong>{item.capability}</strong>
              <span>{item.status}</span>
              {isActive(item) ? (
                <button
                  disabled={item.status === "cancelling"}
                  onClick={() => void cancel(item)}
                  type="button"
                >
                  {item.status === "cancelling" ? "Cancelling…" : "Cancel"}
                </button>
              ) : null}
            </header>
            <small>{item.operationId}</small>
            {item.events.map((event) => (
              <pre key={event.sequence} data-stream={event.event}>
                {payloadText(event.payload)}
              </pre>
            ))}
            {item.events.length === 0 && item.result !== null ? (
              <pre>{payloadText(item.result)}</pre>
            ) : null}
            {item.error === null ? null : (
              <pre className="execution-error">{item.error.message}</pre>
            )}
          </article>
        ))}
      </div>
    </section>
  );
};
