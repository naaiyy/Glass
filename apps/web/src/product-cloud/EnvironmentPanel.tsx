import type { ConnectPresence } from "@glass/contracts/connect";
import {
  GlassConnectClient,
  type ClientConnectSocket,
} from "@glass/client-runtime/glass-connect-client";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";
import type {
  ExecutionEnvironmentId,
  ExecutionOperationId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { environmentCloud } from "./environment-cloud.ts";

export const EnvironmentPanel = ({
  organizationId,
  onConnectionStatus,
  projects,
}: {
  organizationId: OrganizationId;
  onConnectionStatus: (status: "connecting" | "not-configured" | "online") => void;
  projects: readonly Readonly<{ id: ProjectId; name: string }>[];
}) => {
  const [environments, setEnvironments] = useState<readonly ExecutionEnvironment[]>([]);
  const [presence, setPresence] = useState<Readonly<Record<string, ConnectPresence>>>({});
  const [pairingCode, setPairingCode] = useState("");
  const [rotationCode, setRotationCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | "">(projects[0]?.id ?? "");
  const [bindings, setBindings] = useState<readonly WorkspaceBinding[]>([]);
  const [catalog, setCatalog] = useState<
    Readonly<Record<string, readonly Readonly<{ id: WorkspaceId; name: string }>[]>>
  >({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId | "">("");
  const [operationResult, setOperationResult] = useState<unknown>(null);
  const connection = useRef<GlassConnectClient | null>(null);

  const refresh = useCallback(async () => {
    const items = await environmentCloud.list(organizationId);
    setEnvironments(items);
    const states = await Promise.all(
      items
        .filter((item) => item.revokedAt === null)
        .map(
          async (item) =>
            [item.id, await environmentCloud.presence(organizationId, item.id)] as const,
        ),
    );
    setPresence(Object.fromEntries(states));
  }, [organizationId]);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "Could not load execution environments."),
    );
  }, [refresh]);
  useEffect(() => {
    if (projectId === "") {
      setBindings([]);
      return;
    }
    void environmentCloud
      .bindings(organizationId, projectId)
      .then(setBindings)
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : "Could not load workspace bindings."),
      );
  }, [organizationId, projectId]);
  useEffect(() => {
    if (projectId === "" && projects[0] !== undefined) setProjectId(projects[0].id);
  }, [projectId, projects]);
  useEffect(() => {
    if (window.location.hash === "#glass-connect-pair") {
      document.querySelector<HTMLInputElement>("#pairing-code")?.focus();
    }
  }, []);
  useEffect(() => () => connection.current?.stop(), []);

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await environmentCloud.approve(organizationId, pairingCode.trim().toUpperCase());
      setPairingCode("");
      setMessage("Pairing approved. The execution environment is proving its identity now.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pairing approval failed.");
    } finally {
      setBusy(false);
    }
  };

  const approveRotation = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await environmentCloud.approveRotation(organizationId, rotationCode.trim().toUpperCase());
      setRotationCode("");
      setMessage(
        "Key rotation approved. The environment must now prove possession of its new key.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Key rotation approval failed.");
    } finally {
      setBusy(false);
    }
  };

  const connect = async (environmentId: ExecutionEnvironmentId) => {
    setBusy(true);
    try {
      if (projectId === "") throw new Error("Choose a project first.");
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (environment === undefined) throw new Error("Execution environment is unavailable.");
      const projectBindings = bindings.filter(
        (binding) =>
          binding.environmentId === environmentId &&
          binding.projectId === projectId &&
          binding.revokedAt === null,
      );
      const binding =
        projectBindings.find((candidate) => candidate.id === selectedWorkspaceId) ??
        projectBindings[0];
      if (binding === undefined)
        throw new Error(
          "An organization administrator must bind an advertised workspace to this project first.",
        );
      const operationId = crypto.randomUUID() as ExecutionOperationId;
      const requestId = crypto.randomUUID();
      const dispatch = await environmentCloud.createFileList(
        organizationId,
        environmentId,
        projectId,
        binding.id,
        operationId,
        requestId,
      );
      connection.current?.stop();
      let dispatched = false;
      const client = new GlassConnectClient({
        environmentIdentity: {
          id: environment.id,
          keyVersion: environment.keyVersion,
          organizationId: environment.organizationId,
          publicKey: environment.publicKey,
        },
        getTicket: (clientNonce) =>
          environmentCloud.ticket(organizationId, environmentId, clientNonce),
        makeSocket: (ticket) =>
          new WebSocket(ticket.websocketUrl, [
            "glass-connect-v2",
            `glass-ticket.${ticket.ticket}`,
          ]) as ClientConnectSocket,
        onFrame: (frame) => {
          if (frame.type === "operation.error") setMessage(frame.error.message);
          else if (frame.event === "progress")
            setMessage("The execution node is streaming workspace discovery progress.");
          else {
            setOperationResult(frame.payload);
            setMessage("Authorized workspace discovery completed.");
          }
        },
        onOnline: () => {
          void (async () => {
            if (dispatched) {
              const durable = await environmentCloud.operation(operationId);
              if (["succeeded", "failed", "cancelled"].includes(durable.status)) {
                setOperationResult(durable.result ?? durable.error);
                setMessage(`Durable execution state: ${durable.status}.`);
                client.stop();
                return;
              }
              setMessage(
                `Durable execution state: ${durable.status}. Waiting for node journal reconciliation without redispatching side effects.`,
              );
              return;
            }
            dispatched = client.send({
              type: "operation.request",
              requestId,
              operationId,
              capability: "file.list",
              dispatchGrant: dispatch.dispatchGrant,
              payload: { operation: "file.list", workspaceId: binding.id, path: "." },
            });
            if (dispatched)
              setMessage(
                "Connected through Glass Connect. Loading the authorized workspace binding…",
              );
          })().catch((error: unknown) =>
            setMessage(error instanceof Error ? error.message : "Execution reconnect failed."),
          );
        },
        onStatus: (status) => {
          if (status.status === "online") onConnectionStatus("online");
          else if (status.status === "connecting" || status.status === "reconnecting") {
            onConnectionStatus("connecting");
            if (status.status === "reconnecting") {
              setMessage("Execution is reconnecting. Product access remains available.");
              void environmentCloud
                .operation(operationId)
                .then((operation) => {
                  setOperationResult(operation.result ?? operation.error);
                  setMessage(`Durable execution state: ${operation.status}. Reconnecting…`);
                })
                .catch(() => undefined);
            }
          } else if (status.status === "stopped") onConnectionStatus("not-configured");
        },
      });
      connection.current = client;
      client.start();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="state-panel"
      aria-label="Glass Connect environments"
      id="glass-connect-pair"
    >
      <h2>Glass Connect</h2>
      <p>
        Publish a capable computer from the Glass execution node, then approve its one-time pairing
        code here. Signing in alone never publishes a device.
      </p>
      <form onSubmit={(event) => void approve(event)}>
        <label htmlFor="pairing-code">Pairing code</label>
        <div className="organization-picker">
          <input
            id="pairing-code"
            autoCapitalize="characters"
            maxLength={11}
            placeholder="ABCDE-FGHIJ"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
          />
          <button disabled={busy || pairingCode.trim().length !== 11} type="submit">
            Approve publishing
          </button>
        </div>
      </form>
      <form onSubmit={(event) => void approveRotation(event)}>
        <label htmlFor="rotation-code">Environment key-rotation code</label>
        <div className="organization-picker">
          <input
            id="rotation-code"
            autoCapitalize="characters"
            maxLength={11}
            placeholder="ABCDE-FGHIJ"
            value={rotationCode}
            onChange={(event) => setRotationCode(event.target.value)}
          />
          <button disabled={busy || rotationCode.trim().length !== 11} type="submit">
            Approve key rotation
          </button>
        </div>
      </form>
      <label htmlFor="connect-project">Project authorization</label>
      <select
        id="connect-project"
        value={projectId}
        onChange={(event) => setProjectId(event.target.value as ProjectId)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {message === null ? null : <p role="status">{message}</p>}
      {operationResult === null ? null : <pre>{JSON.stringify(operationResult, null, 2)}</pre>}
      {environments.length === 0 ? (
        <p>No execution environments are published to this organization.</p>
      ) : (
        environments.map((environment) => {
          const state = presence[environment.id];
          const environmentBindings = bindings.filter(
            (binding) =>
              binding.environmentId === environment.id &&
              binding.projectId === projectId &&
              binding.revokedAt === null,
          );
          const environmentCatalog = catalog[environment.id] ?? [];
          return (
            <article className="entity-card" key={environment.id}>
              <strong>{environment.displayName}</strong>
              <span>
                {environment.platform} ·{" "}
                {environment.revokedAt === null ? (state?.status ?? "checking") : "revoked"}
              </span>
              {environment.revokedAt === null ? (
                <div>
                  {environmentBindings.length === 0 ? (
                    <p>No workspace is bound to this project.</p>
                  ) : (
                    <select
                      aria-label={`Workspace for ${environment.displayName}`}
                      value={
                        environmentBindings.some((binding) => binding.id === selectedWorkspaceId)
                          ? selectedWorkspaceId
                          : environmentBindings[0]?.id
                      }
                      onChange={(event) =>
                        setSelectedWorkspaceId(event.target.value as WorkspaceId)
                      }
                    >
                      {environmentBindings.map((binding) => (
                        <option key={binding.id} value={binding.id}>
                          {binding.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={busy || state?.status !== "online"}
                    onClick={() => {
                      setBusy(true);
                      void environmentCloud
                        .catalog(organizationId, environment.id)
                        .then((items) =>
                          setCatalog((current) => ({ ...current, [environment.id]: items })),
                        )
                        .catch((error: unknown) =>
                          setMessage(
                            error instanceof Error
                              ? error.message
                              : "The workspace catalog is available only to administrators while the node is online.",
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    Load advertised workspaces
                  </button>{" "}
                  {environmentCatalog.length === 0 ? null : (
                    <>
                      <select
                        aria-label={`Advertised workspace for ${environment.displayName}`}
                        value={selectedWorkspaceId}
                        onChange={(event) =>
                          setSelectedWorkspaceId(event.target.value as WorkspaceId)
                        }
                      >
                        <option value="">Choose workspace</option>
                        {environmentCatalog.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={busy || projectId === "" || selectedWorkspaceId === ""}
                        onClick={() => {
                          const workspace = environmentCatalog.find(
                            (item) => item.id === selectedWorkspaceId,
                          );
                          if (workspace === undefined || projectId === "") return;
                          setBusy(true);
                          void environmentCloud
                            .bindWorkspace(organizationId, environment.id, projectId, workspace.id)
                            .then(() => environmentCloud.bindings(organizationId, projectId))
                            .then(setBindings)
                            .catch((error: unknown) =>
                              setMessage(
                                error instanceof Error
                                  ? error.message
                                  : "Workspace binding failed.",
                              ),
                            )
                            .finally(() => setBusy(false));
                        }}
                        type="button"
                      >
                        Bind to project
                      </button>
                    </>
                  )}{" "}
                  <button
                    disabled={busy || state?.status !== "online"}
                    onClick={() => void connect(environment.id)}
                    type="button"
                  >
                    Connect
                  </button>{" "}
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void environmentCloud
                        .revoke(environment.id)
                        .then(() => {
                          connection.current?.stop();
                          return refresh();
                        })
                        .catch((error: unknown) =>
                          setMessage(error instanceof Error ? error.message : "Revocation failed."),
                        )
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    Revoke
                  </button>
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
};
