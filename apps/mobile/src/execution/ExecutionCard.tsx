import {
  GlassConnectClient,
  type ClientConnectSocket,
} from "@glass/client-runtime/glass-connect-client";
import type { ConnectOperationCancel } from "@glass/contracts/connect";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { ExecutionRequest } from "@glass/contracts/execution";
import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";
import type {
  ExecutionOperationId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useCSSVariable } from "uniwind";

import {
  approveEnvironmentPairing,
  approveEnvironmentRotation,
  authorizeEnvironmentConnection,
  bindWorkspace,
  cancelExecutionOperation,
  createExecutionOperation,
  listEnvironments,
  listWorkspaceBindings,
  loadEnvironmentPresence,
  loadWorkspaceCatalog,
  redispatchExecutionOperation,
  revokeEnvironment,
} from "../cloud/environments.ts";
import {
  buildMobileExecutionRequest,
  type MobileExecutionDraft,
} from "../cloud/execution-console.ts";
import { resolveApiBaseUrl } from "../cloud/transport.ts";
import { MobileExecutionConsole } from "../ExecutionConsole.tsx";
import { errorMessage } from "../lib/errors.ts";
import { ActionButton, AppInput, SelectMenu, StateCard } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

export const ExecutionCard = ({
  organizationId,
  projects,
}: {
  organizationId: OrganizationId | null;
  projects: readonly Readonly<{ id: ProjectId; name: string }>[];
}) => {
  const [resolvedForeground, resolvedMutedForeground, resolvedBackground, resolvedBorder] =
    useCSSVariable([
      "--color-foreground",
      "--color-muted-foreground",
      "--color-background",
      "--color-border",
    ]);
  const foregroundColor = typeof resolvedForeground === "string" ? resolvedForeground : "#18181b";
  const mutedForegroundColor =
    typeof resolvedMutedForeground === "string" ? resolvedMutedForeground : "#71717a";
  const backgroundColor = typeof resolvedBackground === "string" ? resolvedBackground : "#ffffff";
  const borderColor = typeof resolvedBorder === "string" ? resolvedBorder : "#e4e4e7";
  const themeStyles = {
    body: { color: foregroundColor },
    connectionRow: { borderColor },
    executionOutput: { backgroundColor, borderColor },
    input: { backgroundColor, borderColor, color: foregroundColor },
    label: { color: foregroundColor },
    muted: { color: mutedForegroundColor },
  } as const;
  const [environments, setEnvironments] = useState<readonly ExecutionEnvironment[]>([]);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const [bindings, setBindings] = useState<readonly WorkspaceBinding[]>([]);
  const [catalog, setCatalog] = useState<
    Readonly<Record<string, readonly Readonly<{ id: WorkspaceId; name: string }>[]>>
  >({});
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId | null>(null);
  const [connectionOnline, setConnectionOnline] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [progress, setProgress] = useState<readonly string[]>([]);
  const [activeExecution, setActiveExecution] = useState<Readonly<{
    apiBaseUrl: string;
    operationId: ExecutionOperationId;
    requestId: string;
  }> | null>(null);
  const [executionPending, setExecutionPending] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [rotationCode, setRotationCode] = useState("");
  const [trustActionPending, setTrustActionPending] = useState(false);
  const [environmentGeneration, setEnvironmentGeneration] = useState(0);
  const connection = useRef<GlassConnectClient | null>(null);
  const activeExecutionRef = useRef(activeExecution);
  const pendingCancellation = useRef<ConnectOperationCancel | null>(null);

  useEffect(() => {
    activeExecutionRef.current = activeExecution;
  }, [activeExecution]);

  const connectEnvironment = (environment: ExecutionEnvironment, binding: WorkspaceBinding) => {
    if (organizationId === null || projectId === null) return;
    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
    connection.current?.stop();
    setConnectionOnline(false);
    setSelectedEnvironmentId(environment.id);
    setSelectedWorkspaceId(binding.id);
    setProgress([]);
    setResult(null);
    const client = new GlassConnectClient({
      environmentIdentity: {
        id: environment.id,
        keyVersion: environment.keyVersion,
        organizationId: environment.organizationId,
        publicKey: environment.publicKey,
      },
      getTicket: (clientNonce) =>
        authorizeEnvironmentConnection(apiBaseUrl, organizationId, environment.id, clientNonce),
      makeSocket: (ticket) =>
        new WebSocket(ticket.websocketUrl, [
          "glass-connect-v2",
          `glass-ticket.${ticket.ticket}`,
        ]) as unknown as ClientConnectSocket,
      onFrame: (frame) => {
        if (frame.type === "operation.error") {
          setMessage(frame.error.message);
          setResult(frame.error);
          setActiveExecution(null);
          pendingCancellation.current = null;
          return;
        }
        if (frame.event === "progress") {
          const payload = frame.payload;
          const line =
            typeof payload === "object" &&
            payload !== null &&
            "data" in payload &&
            typeof payload.data === "string"
              ? `${"stream" in payload ? `[${String(payload.stream)}] ` : ""}${payload.data}`
              : JSON.stringify(payload);
          setProgress((current) => [...current, line].slice(-200));
          setMessage("The operation is streaming from the execution node.");
          return;
        }
        setResult(frame.payload);
        setMessage("The operation completed and its result is durable.");
        setActiveExecution(null);
        pendingCancellation.current = null;
      },
      onOnline: () => {
        setConnectionOnline(true);
        setMessage(
          `Connected to ${environment.displayName} through Glass Connect for ${binding.displayName}.`,
        );
        if (pendingCancellation.current !== null && client.send(pendingCancellation.current)) {
          pendingCancellation.current = null;
          setMessage("Cancellation sent after execution reconnected.");
        }
        const active = activeExecutionRef.current;
        if (active === null) return;
        void redispatchExecutionOperation(apiBaseUrl, active.operationId)
          .then((redispatch) => {
            if (!("dispatchGrant" in redispatch)) {
              setResult(redispatch.result ?? redispatch.error);
              setProgress(
                redispatch.events
                  .filter((event) => event.event === "progress")
                  .map((event) => JSON.stringify(event.payload)),
              );
              if (["succeeded", "failed", "cancelled"].includes(redispatch.status)) {
                setActiveExecution(null);
                pendingCancellation.current = null;
              }
              return;
            }
            client.send({
              type: "operation.request",
              requestId: redispatch.operation.requestId,
              operationId: redispatch.operation.operationId,
              capability: redispatch.operation.request.operation,
              dispatchGrant: redispatch.dispatchGrant,
              payload: redispatch.operation.request,
            });
          })
          .catch((error: unknown) => setMessage(errorMessage(error)));
      },
      onStatus: (status) => {
        setConnectionOnline(status.status === "online");
        if (status.status === "reconnecting") {
          setMessage("Execution is reconnecting. Glass Cloud product access remains available.");
        }
      },
    });
    connection.current = client;
    client.start();
  };

  const startExecution = (
    environment: ExecutionEnvironment,
    binding: WorkspaceBinding,
    draft: MobileExecutionDraft,
  ) => {
    if (organizationId === null || projectId === null) return;
    let executionRequest: ExecutionRequest;
    try {
      executionRequest = buildMobileExecutionRequest(draft, binding.id);
    } catch (error) {
      setMessage(errorMessage(error));
      return;
    }
    const client = connection.current;
    if (!connectionOnline || client === null) {
      setMessage("Connect an online execution environment before running a capability.");
      return;
    }
    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
    const operationId = randomUUID() as ExecutionOperationId;
    const requestId = randomUUID();
    setProgress([]);
    setResult(null);
    setExecutionPending(true);
    pendingCancellation.current = null;
    setMessage(`Creating durable ${executionRequest.operation} intent…`);
    void createExecutionOperation(
      apiBaseUrl,
      organizationId,
      environment.id,
      projectId,
      binding.id,
      operationId,
      requestId,
      executionRequest,
    )
      .then((dispatch) => {
        const active = { apiBaseUrl, operationId, requestId } as const;
        activeExecutionRef.current = active;
        setActiveExecution(active);
        setExecutionPending(false);
        const sent = client.send({
          type: "operation.request",
          requestId,
          operationId,
          capability: executionRequest.operation,
          dispatchGrant: dispatch.dispatchGrant,
          payload: executionRequest,
        });
        setMessage(
          sent
            ? `${executionRequest.operation} was durably authorized and dispatched.`
            : "The durable operation was created, but the connection changed before dispatch.",
        );
      })
      .catch((error: unknown) => {
        setExecutionPending(false);
        setActiveExecution(null);
        setMessage(errorMessage(error));
      });
  };

  const cancelActiveExecution = () => {
    const active = activeExecution;
    if (active === null) return;
    void cancelExecutionOperation(active.apiBaseUrl, active.operationId)
      .then((cancellation) => {
        if (!("dispatchGrant" in cancellation)) {
          setResult(cancellation.result ?? cancellation.error);
          setMessage(`Durable execution state: ${cancellation.status}.`);
          setActiveExecution(null);
          activeExecutionRef.current = null;
          pendingCancellation.current = null;
          return;
        }
        const cancellationFrame: ConnectOperationCancel = {
          type: "operation.cancel",
          operationId: active.operationId,
          requestId: active.requestId,
          dispatchGrant: cancellation.dispatchGrant,
          reason: "Cancelled from Glass mobile",
        };
        const accepted = connection.current?.send(cancellationFrame);
        if (!accepted) pendingCancellation.current = cancellationFrame;
        setMessage(
          accepted
            ? "Cancellation sent. Waiting for the durable terminal result."
            : "Cancellation is durable in Glass Cloud and will reconcile when execution reconnects.",
        );
      })
      .catch((error: unknown) => setMessage(errorMessage(error)));
  };
  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) {
      setProjectId(projects[0]?.id ?? null);
      connection.current?.stop();
      setConnectionOnline(false);
      setSelectedEnvironmentId(null);
      setSelectedWorkspaceId(null);
    }
  }, [projectId, projects]);
  useEffect(() => {
    if (organizationId === null || projectId === null) {
      setBindings([]);
      return;
    }
    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
    void listWorkspaceBindings(apiBaseUrl, organizationId, projectId)
      .then(setBindings)
      .catch((error: unknown) => setMessage(errorMessage(error)));
  }, [organizationId, projectId]);
  useEffect(() => {
    if (organizationId === null) {
      setEnvironments([]);
      return;
    }
    let active = true;
    const run = async () => {
      const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
      const items = await listEnvironments(apiBaseUrl, organizationId);
      const states = await Promise.all(
        items
          .filter((item) => item.revokedAt === null)
          .map(
            async (item) =>
              [
                item.id,
                await loadEnvironmentPresence(apiBaseUrl, organizationId, item.id),
              ] as const,
          ),
      );
      if (active) {
        setEnvironments(items);
        setOnline(
          new Set(states.filter((entry) => entry[1].status === "online").map((entry) => entry[0])),
        );
      }
    };
    void run().catch((error: unknown) => active && setMessage(errorMessage(error)));
    return () => {
      active = false;
    };
  }, [environmentGeneration, organizationId]);
  useEffect(() => () => connection.current?.stop(), []);
  return (
    <StateCard title="Glass Connect">
      {organizationId === null ? null : (
        <>
          <Text style={[styles.label, themeStyles.label]}>Pairing code</Text>
          <AppInput
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            onChangeText={setPairingCode}
            placeholder="ABCDE-FGHIJ"
            value={pairingCode}
          />
          <ActionButton
            disabled={trustActionPending || pairingCode.trim().length !== 11}
            label={trustActionPending ? "Approving…" : "Approve"}
            onPress={() => {
              const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
              setTrustActionPending(true);
              void approveEnvironmentPairing(
                apiBaseUrl,
                organizationId,
                pairingCode.trim().toUpperCase(),
              )
                .then(() => {
                  setPairingCode("");
                  setMessage(
                    "Pairing approved. The execution environment is proving its identity.",
                  );
                  setEnvironmentGeneration((value) => value + 1);
                })
                .catch((error: unknown) => setMessage(errorMessage(error)))
                .finally(() => setTrustActionPending(false));
            }}
          />
          <Text style={[styles.label, themeStyles.label]}>Key-rotation code</Text>
          <AppInput
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            onChangeText={setRotationCode}
            placeholder="ABCDE-FGHIJ"
            value={rotationCode}
          />
          <ActionButton
            disabled={trustActionPending || rotationCode.trim().length !== 11}
            label={trustActionPending ? "Approving…" : "Approve"}
            onPress={() => {
              const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
              setTrustActionPending(true);
              void approveEnvironmentRotation(
                apiBaseUrl,
                organizationId,
                rotationCode.trim().toUpperCase(),
              )
                .then(() => {
                  setRotationCode("");
                  setMessage(
                    "Key rotation approved. The environment must now prove possession of its new key.",
                  );
                })
                .catch((error: unknown) => setMessage(errorMessage(error)))
                .finally(() => setTrustActionPending(false));
            }}
          />
        </>
      )}
      <SelectMenu
        disabled={projects.length === 0}
        label="Project authorization"
        onSelect={(nextProjectId) => {
          connection.current?.stop();
          setConnectionOnline(false);
          setSelectedEnvironmentId(null);
          setSelectedWorkspaceId(null);
          setProjectId(nextProjectId);
        }}
        options={projects.map((project) => ({ label: project.name, value: project.id }))}
        placeholder="Choose a project"
        value={projectId}
      />
      {environments.length === 0 ? (
        <Text style={[styles.body, themeStyles.body]}>
          No execution environments are published.
        </Text>
      ) : (
        environments
          .filter((item) => item.revokedAt === null)
          .map((item) => {
            const environmentBindings = bindings.filter(
              (binding) =>
                binding.environmentId === item.id &&
                binding.projectId === projectId &&
                binding.revokedAt === null,
            );
            const environmentCatalog = catalog[item.id] ?? [];
            return (
              <View key={item.id} style={[styles.connectionRow, themeStyles.connectionRow]}>
                <View>
                  <Text style={[styles.label, themeStyles.label]}>{item.displayName}</Text>
                  <Text style={[styles.muted, themeStyles.muted]}>
                    {item.platform} · {online.has(item.id) ? "online" : "offline"}
                  </Text>
                </View>
                <SelectMenu
                  disabled={environmentBindings.length === 0}
                  label="Workspace"
                  onSelect={setSelectedWorkspaceId}
                  options={environmentBindings.map((binding) => ({
                    label: binding.displayName,
                    value: binding.id,
                  }))}
                  placeholder="Choose a workspace"
                  value={
                    environmentBindings.some((binding) => binding.id === selectedWorkspaceId)
                      ? selectedWorkspaceId
                      : null
                  }
                />
                <ActionButton
                  disabled={!online.has(item.id) || organizationId === null}
                  label="Load workspaces"
                  onPress={() => {
                    if (organizationId === null) return;
                    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                    void loadWorkspaceCatalog(apiBaseUrl, organizationId, item.id)
                      .then((items) => setCatalog((current) => ({ ...current, [item.id]: items })))
                      .catch((error: unknown) => setMessage(errorMessage(error)));
                  }}
                />
                {environmentCatalog.length === 0 ? null : (
                  <>
                    <SelectMenu
                      label="Advertised workspace"
                      onSelect={setSelectedWorkspaceId}
                      options={environmentCatalog.map((workspace) => ({
                        label: workspace.name,
                        value: workspace.id,
                      }))}
                      placeholder="Choose a workspace"
                      value={
                        environmentCatalog.some((workspace) => workspace.id === selectedWorkspaceId)
                          ? selectedWorkspaceId
                          : null
                      }
                    />
                    <ActionButton
                      disabled={
                        projectId === null ||
                        !environmentCatalog.some(
                          (workspace) => workspace.id === selectedWorkspaceId,
                        )
                      }
                      label="Bind to project"
                      onPress={() => {
                        if (
                          organizationId === null ||
                          projectId === null ||
                          selectedWorkspaceId === null
                        )
                          return;
                        const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                        void bindWorkspace(
                          apiBaseUrl,
                          organizationId,
                          item.id,
                          projectId,
                          selectedWorkspaceId,
                        )
                          .then(() => listWorkspaceBindings(apiBaseUrl, organizationId, projectId))
                          .then(setBindings)
                          .catch((error: unknown) => setMessage(errorMessage(error)));
                      }}
                    />
                  </>
                )}
                <ActionButton
                  disabled={
                    !online.has(item.id) ||
                    !environmentBindings.some((binding) => binding.id === selectedWorkspaceId)
                  }
                  label="Connect"
                  onPress={() => {
                    const binding = environmentBindings.find(
                      (candidate) => candidate.id === selectedWorkspaceId,
                    );
                    if (binding !== undefined) connectEnvironment(item, binding);
                  }}
                />
                {selectedEnvironmentId === item.id
                  ? (() => {
                      const binding = environmentBindings.find(
                        (candidate) => candidate.id === selectedWorkspaceId,
                      );
                      return binding === undefined ? (
                        <Text style={[styles.muted, themeStyles.muted]}>
                          Select a project-authorized workspace to use execution capabilities.
                        </Text>
                      ) : (
                        <MobileExecutionConsole
                          active={activeExecution !== null}
                          disabled={
                            executionPending ||
                            !connectionOnline ||
                            !online.has(item.id) ||
                            organizationId === null
                          }
                          onCancel={cancelActiveExecution}
                          onRun={(draft) => startExecution(item, binding, draft)}
                        />
                      );
                    })()
                  : null}
                <ActionButton
                  disabled={trustActionPending}
                  label="Revoke"
                  onPress={() => {
                    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                    setTrustActionPending(true);
                    void revokeEnvironment(apiBaseUrl, item.id)
                      .then(() => {
                        connection.current?.stop();
                        setMessage(`${item.displayName} was revoked.`);
                        setEnvironmentGeneration((value) => value + 1);
                      })
                      .catch((error: unknown) => setMessage(errorMessage(error)))
                      .finally(() => setTrustActionPending(false));
                  }}
                />
              </View>
            );
          })
      )}
      {message === null ? null : <Text style={[styles.muted, themeStyles.muted]}>{message}</Text>}
      {progress.length === 0 ? null : (
        <View style={[styles.executionOutput, themeStyles.executionOutput]}>
          <Text style={[styles.label, themeStyles.label]}>
            Streaming output · latest {progress.length} line(s)
          </Text>
          <Text selectable style={[styles.muted, themeStyles.muted]}>
            {progress.join("")}
          </Text>
        </View>
      )}
      {result === null ? null : (
        <Text selectable style={[styles.muted, themeStyles.muted]}>
          {JSON.stringify(result, null, 2)}
        </Text>
      )}
    </StateCard>
  );
};
