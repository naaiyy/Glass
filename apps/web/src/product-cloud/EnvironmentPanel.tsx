import type { ConnectPresence } from "@glass/contracts/connect";
import {
  GlassConnectClient,
  type ClientConnectSocket,
} from "@glass/client-runtime/glass-connect-client";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { ExecutionRequest } from "@glass/contracts/execution";
import type { ExecutionOperation, WorkspaceBinding } from "@glass/contracts/execution-cloud";
import type {
  ExecutionEnvironmentId,
  ExecutionOperationId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { environmentCloud } from "./environment-cloud.ts";
import { ExecutionConsole } from "./ExecutionConsole.tsx";

type ConnectedScope = Readonly<{
  binding: WorkspaceBinding;
  environment: ExecutionEnvironment;
  projectId: ProjectId;
}>;

export const EnvironmentPanel = ({
  organizationId,
  projects,
}: {
  organizationId: OrganizationId;
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
  const [connectedScope, setConnectedScope] = useState<ConnectedScope | null>(null);
  const [executionOnline, setExecutionOnline] = useState(false);
  const [operations, setOperations] = useState<readonly ExecutionOperation[]>([]);
  const connection = useRef<GlassConnectClient | null>(null);
  const connectionOnline = useRef(false);
  const trackedOperationIds = useRef<Set<ExecutionOperationId>>(new Set());
  const fetchedSequence = useRef<Map<ExecutionOperationId, number>>(new Map());

  const upsertOperation = useCallback((operation: ExecutionOperation) => {
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) {
      trackedOperationIds.current.delete(operation.operationId);
    } else {
      trackedOperationIds.current.add(operation.operationId);
    }
    setOperations((current) => {
      const existing = current.find((candidate) => candidate.operationId === operation.operationId);
      const eventMap = new Map(
        [...(existing?.events ?? []), ...operation.events].map((event) => [event.sequence, event]),
      );
      const merged = {
        ...operation,
        events: [...eventMap.values()].sort((a, b) => a.sequence - b.sequence),
      };
      return [
        merged,
        ...current.filter((candidate) => candidate.operationId !== operation.operationId),
      ];
    });
  }, []);

  const refreshOperation = useCallback(
    async (operationId: ExecutionOperationId) => {
      const durable = await environmentCloud.operation(
        operationId,
        fetchedSequence.current.get(operationId) ?? -1,
      );
      if (durable.events.length > 0) {
        fetchedSequence.current.set(
          operationId,
          Math.max(...durable.events.map((event) => event.sequence)),
        );
      }
      upsertOperation(durable);
    },
    [upsertOperation],
  );

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
  useEffect(() => {
    if (connectedScope === null) return;
    const handle = window.setInterval(() => {
      for (const operationId of trackedOperationIds.current) {
        void refreshOperation(operationId).catch(() => undefined);
      }
    }, 1_500);
    return () => window.clearInterval(handle);
  }, [connectedScope, refreshOperation]);

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
      connection.current?.stop();
      connectionOnline.current = false;
      setExecutionOnline(false);
      trackedOperationIds.current = new Set();
      fetchedSequence.current = new Map();
      setOperations([]);
      setConnectedScope({ binding, environment, projectId });
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
          void refreshOperation(frame.operationId as ExecutionOperationId).catch((error: unknown) =>
            setMessage(
              error instanceof Error
                ? error.message
                : "Could not refresh the durable execution operation.",
            ),
          );
        },
        onOnline: () => {
          connectionOnline.current = true;
          setExecutionOnline(true);
          setMessage(
            `Connected to ${environment.displayName} through Glass Connect. Machine capabilities are available for ${binding.displayName}.`,
          );
          // Only Cloud may decide that an unclaimed durable operation is dispatchable again.
          // A running or terminal operation comes back without a grant and is never replayed.
          void Promise.all(
            [...trackedOperationIds.current].map(async (operationId) => {
              const durable = await environmentCloud.redispatch(operationId);
              if (!("dispatchGrant" in durable)) {
                upsertOperation(durable);
                return;
              }
              upsertOperation(durable.operation);
              client.send({
                type: "operation.request",
                requestId: durable.operation.requestId,
                operationId: durable.operation.operationId,
                capability: durable.operation.request.operation,
                dispatchGrant: durable.dispatchGrant,
                payload: durable.operation.request,
              });
            }),
          ).catch((error: unknown) =>
            setMessage(
              error instanceof Error
                ? error.message
                : "Could not reconcile durable operations after reconnecting.",
            ),
          );
        },
        onStatus: (status) => {
          if (status.status === "online") {
            connectionOnline.current = true;
            setExecutionOnline(true);
          } else if (status.status === "connecting" || status.status === "reconnecting") {
            connectionOnline.current = false;
            setExecutionOnline(false);
            if (status.status === "reconnecting") {
              setMessage("Execution is reconnecting. Product access remains available.");
            }
          } else if (status.status === "stopped") {
            connectionOnline.current = false;
            setExecutionOnline(false);
          }
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

  const runOperation = async (request: ExecutionRequest) => {
    const scope = connectedScope;
    const client = connection.current;
    if (scope === null || client === null || !connectionOnline.current) {
      throw new Error("Connect an online execution environment before running a capability.");
    }
    if (!("workspaceId" in request) || request.workspaceId !== scope.binding.id) {
      throw new Error("The request is outside the connected workspace binding.");
    }
    const operationId = crypto.randomUUID() as ExecutionOperationId;
    const requestId = crypto.randomUUID();
    const dispatch = await environmentCloud.createOperation(
      organizationId,
      scope.environment.id,
      scope.projectId,
      scope.binding.id,
      operationId,
      requestId,
      request,
    );
    upsertOperation(dispatch.operation);
    const sent = client.send({
      type: "operation.request",
      requestId,
      operationId,
      capability: request.operation,
      dispatchGrant: dispatch.dispatchGrant,
      payload: request,
    });
    if (!sent) {
      throw new Error(
        "The durable operation was created, but the execution connection changed before dispatch. Its queued state remains visible; reconnect before retrying.",
      );
    }
    setMessage(`${request.operation} was durably authorized and dispatched.`);
  };

  const cancelOperation = async (operation: ExecutionOperation) => {
    const cancelled = await environmentCloud.cancel(operation.operationId);
    upsertOperation(cancelled.operation);
    if (cancelled.dispatchGrant === null) return;
    const sent = connection.current?.send({
      type: "operation.cancel",
      requestId: operation.requestId,
      operationId: operation.operationId,
      dispatchGrant: cancelled.dispatchGrant,
      reason: "Cancelled by the signed-in user from the Glass execution console.",
    });
    if (sent !== true) {
      throw new Error(
        "Cancellation is durable in Glass Cloud, but the environment connection is offline. It will remain cancelling until delivery can complete.",
      );
    }
    setMessage(`Cancellation requested for ${operation.capability}.`);
  };

  return (
    <Card aria-label="Glass Connect environments" className="mt-8" id="glass-connect-pair">
      <CardHeader>
        <CardTitle>Glass Connect</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-4 md:grid-cols-2">
          <form className="grid gap-2" onSubmit={(event) => void approve(event)}>
            <Label htmlFor="pairing-code">Pairing code</Label>
            <div className="flex gap-2">
              <Input
                autoCapitalize="characters"
                className="uppercase"
                id="pairing-code"
                maxLength={11}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="ABCDE-FGHIJ"
                value={pairingCode}
              />
              <Button disabled={busy || pairingCode.trim().length !== 11} type="submit">
                Approve
              </Button>
            </div>
          </form>
          <form className="grid gap-2" onSubmit={(event) => void approveRotation(event)}>
            <Label htmlFor="rotation-code">Key-rotation code</Label>
            <div className="flex gap-2">
              <Input
                autoCapitalize="characters"
                className="uppercase"
                id="rotation-code"
                maxLength={11}
                onChange={(event) => setRotationCode(event.target.value)}
                placeholder="ABCDE-FGHIJ"
                value={rotationCode}
              />
              <Button disabled={busy || rotationCode.trim().length !== 11} type="submit">
                Approve
              </Button>
            </div>
          </form>
        </div>

        <div className="grid max-w-sm gap-2">
          <Label htmlFor="connect-project">Project authorization</Label>
          <NativeSelect
            className="w-full"
            disabled={projects.length === 0}
            id="connect-project"
            onChange={(event) => setProjectId(event.target.value as ProjectId)}
            value={projectId}
          >
            {projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        {message === null ? null : (
          <Alert role="status">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3">
          {environments.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No execution environments are published to this organization.
            </p>
          ) : (
            environments.map((environment) => {
              const state = presence[environment.id];
              const status =
                environment.revokedAt === null ? (state?.status ?? "checking") : "revoked";
              const environmentBindings = bindings.filter(
                (binding) =>
                  binding.environmentId === environment.id &&
                  binding.projectId === projectId &&
                  binding.revokedAt === null,
              );
              const environmentCatalog = catalog[environment.id] ?? [];
              return (
                <Card className="rounded-md" key={environment.id} size="sm">
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{environment.displayName}</CardTitle>
                      <Badge variant={status === "online" ? "secondary" : "outline"}>
                        {status}
                      </Badge>
                    </div>
                    <CardDescription>{environment.platform}</CardDescription>
                  </CardHeader>
                  {environment.revokedAt === null ? (
                    <CardContent className="grid gap-3">
                      {environmentBindings.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No workspace is bound to this project.
                        </p>
                      ) : (
                        <NativeSelect
                          aria-label={`Workspace for ${environment.displayName}`}
                          className="w-full max-w-sm"
                          onChange={(event) =>
                            setSelectedWorkspaceId(event.target.value as WorkspaceId)
                          }
                          value={
                            environmentBindings.some(
                              (binding) => binding.id === selectedWorkspaceId,
                            )
                              ? selectedWorkspaceId
                              : environmentBindings[0]?.id
                          }
                        >
                          {environmentBindings.map((binding) => (
                            <NativeSelectOption key={binding.id} value={binding.id}>
                              {binding.displayName}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      )}

                      {environmentCatalog.length === 0 ? null : (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <NativeSelect
                            aria-label={`Advertised workspace for ${environment.displayName}`}
                            className="w-full sm:max-w-sm"
                            onChange={(event) =>
                              setSelectedWorkspaceId(event.target.value as WorkspaceId)
                            }
                            value={selectedWorkspaceId}
                          >
                            <NativeSelectOption value="">Choose workspace</NativeSelectOption>
                            {environmentCatalog.map((workspace) => (
                              <NativeSelectOption key={workspace.id} value={workspace.id}>
                                {workspace.name}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                          <Button
                            disabled={busy || projectId === "" || selectedWorkspaceId === ""}
                            onClick={() => {
                              const workspace = environmentCatalog.find(
                                (item) => item.id === selectedWorkspaceId,
                              );
                              if (workspace === undefined || projectId === "") return;
                              setBusy(true);
                              void environmentCloud
                                .bindWorkspace(
                                  organizationId,
                                  environment.id,
                                  projectId,
                                  workspace.id,
                                )
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
                          </Button>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={busy || state?.status !== "online"}
                          onClick={() => {
                            setBusy(true);
                            void environmentCloud
                              .catalog(organizationId, environment.id)
                              .then((items) =>
                                setCatalog((current) => ({
                                  ...current,
                                  [environment.id]: items,
                                })),
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
                          variant="outline"
                        >
                          Load workspaces
                        </Button>
                        <Button
                          disabled={busy || state?.status !== "online"}
                          onClick={() => void connect(environment.id)}
                          type="button"
                        >
                          Connect
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            void environmentCloud
                              .revoke(environment.id)
                              .then(() => {
                                connection.current?.stop();
                                connectionOnline.current = false;
                                setExecutionOnline(false);
                                setConnectedScope(null);
                                setOperations([]);
                                trackedOperationIds.current = new Set();
                                fetchedSequence.current = new Map();
                                return refresh();
                              })
                              .catch((error: unknown) =>
                                setMessage(
                                  error instanceof Error ? error.message : "Revocation failed.",
                                ),
                              )
                              .finally(() => setBusy(false));
                          }}
                          type="button"
                          variant="destructive"
                        >
                          Revoke
                        </Button>
                      </div>
                    </CardContent>
                  ) : null}
                </Card>
              );
            })
          )}
        </div>

        {connectedScope === null ? null : (
          <ExecutionConsole
            binding={connectedScope.binding}
            environmentName={connectedScope.environment.displayName}
            online={executionOnline}
            onCancel={cancelOperation}
            onRun={runOperation}
            operations={operations}
          />
        )}
      </CardContent>
    </Card>
  );
};
