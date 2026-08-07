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
import { Text, TextInput, View } from "react-native";

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
  loadExecutionOperation,
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
import { ActionButton, StateCard } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

export const ExecutionCard = ({
  organizationId,
  projects,
}: {
  organizationId: OrganizationId | null;
  projects: readonly Readonly<{ id: ProjectId; name: string }>[];
}) => {
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
  const pendingCancellation = useRef<ConnectOperationCancel | null>(null);

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
              client.stop();
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
              setMessage(`${executionRequest.operation} is streaming from the execution node.`);
              return;
            }
            setResult(frame.payload);
            setMessage(`${executionRequest.operation} completed and its result is durable.`);
            setActiveExecution(null);
            pendingCancellation.current = null;
            client.stop();
          },
          onOnline: () => {
            void (async () => {
              if (dispatched) {
                if (
                  pendingCancellation.current !== null &&
                  client.send(pendingCancellation.current)
                ) {
                  pendingCancellation.current = null;
                  setMessage("Cancellation sent after execution reconnected.");
                }
                const redispatch = await redispatchExecutionOperation(apiBaseUrl, operationId);
                if ("dispatchGrant" in redispatch) {
                  const accepted = client.send({
                    type: "operation.request",
                    requestId: redispatch.operation.requestId,
                    operationId: redispatch.operation.operationId,
                    capability: redispatch.operation.request.operation,
                    dispatchGrant: redispatch.dispatchGrant,
                    payload: redispatch.operation.request,
                  });
                  setMessage(
                    accepted
                      ? `Redispatched queued ${executionRequest.operation} after reconnecting.`
                      : "The durable operation is queued, but this connection changed before redispatch.",
                  );
                  return;
                }
                const durable = redispatch;
                setProgress(
                  durable.events
                    .filter((event) => event.event === "progress")
                    .map((event) => JSON.stringify(event.payload)),
                );
                if (["succeeded", "failed", "cancelled"].includes(durable.status)) {
                  setResult(durable.result ?? durable.error);
                  setMessage(`Durable execution state: ${durable.status}.`);
                  setActiveExecution(null);
                  pendingCancellation.current = null;
                  client.stop();
                  return;
                }
                setMessage(
                  `Durable execution state: ${durable.status}. Waiting for node reconciliation without redispatching side effects.`,
                );
                return;
              }
              dispatched = client.send({
                type: "operation.request",
                requestId,
                operationId,
                capability: executionRequest.operation,
                dispatchGrant: dispatch.dispatchGrant,
                payload: executionRequest,
              });
              if (dispatched)
                setMessage(
                  `Connected through Glass Connect. Running ${executionRequest.operation}…`,
                );
            })().catch((error: unknown) => setMessage(errorMessage(error)));
          },
          onStatus: (status) => {
            if (status.status !== "reconnecting") return;
            setMessage("Execution is reconnecting. Glass Cloud product access remains available.");
            void loadExecutionOperation(apiBaseUrl, operationId)
              .then((operation) => {
                setResult(operation.result ?? operation.error);
                setProgress(
                  operation.events
                    .filter((event) => event.event === "progress")
                    .map((event) => JSON.stringify(event.payload)),
                );
                setMessage(`Durable execution state: ${operation.status}. Reconnecting…`);
              })
              .catch(() => undefined);
          },
        });
        connection.current = client;
        setActiveExecution({ apiBaseUrl, operationId, requestId });
        setExecutionPending(false);
        client.start();
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
          pendingCancellation.current = null;
          connection.current?.stop();
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
    if (projectId === null && projects[0] !== undefined) setProjectId(projects[0].id);
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
      <Text style={styles.muted}>
        Signing in discovers published computers. Publishing remains an explicit action on a capable
        computer.
      </Text>
      {organizationId === null ? null : (
        <>
          <Text style={styles.label}>Approve environment publishing</Text>
          <TextInput
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            onChangeText={setPairingCode}
            placeholder="ABCDE-FGHIJ"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={pairingCode}
          />
          <ActionButton
            disabled={trustActionPending || pairingCode.trim().length !== 11}
            label={trustActionPending ? "Approving…" : "Approve publishing"}
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
          <Text style={styles.label}>Approve environment key rotation</Text>
          <TextInput
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            onChangeText={setRotationCode}
            placeholder="ABCDE-FGHIJ"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={rotationCode}
          />
          <ActionButton
            disabled={trustActionPending || rotationCode.trim().length !== 11}
            label={trustActionPending ? "Approving…" : "Approve key rotation"}
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
      <Text style={styles.label}>Project authorization</Text>
      {projects.map((project) => (
        <ActionButton
          key={project.id}
          label={`${project.name}${project.id === projectId ? " · selected" : ""}`}
          onPress={() => setProjectId(project.id)}
        />
      ))}
      {environments.length === 0 ? (
        <Text style={styles.body}>No execution environments are published.</Text>
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
              <View key={item.id} style={styles.connectionRow}>
                <View>
                  <Text style={styles.label}>{item.displayName}</Text>
                  <Text style={styles.muted}>
                    {item.platform} · {online.has(item.id) ? "online" : "offline"}
                  </Text>
                </View>
                {environmentBindings.map((binding) => (
                  <ActionButton
                    key={binding.id}
                    label={`${binding.displayName}${binding.id === selectedWorkspaceId ? " · selected" : ""}`}
                    onPress={() => {
                      setSelectedEnvironmentId(item.id);
                      setSelectedWorkspaceId(binding.id);
                    }}
                  />
                ))}
                <ActionButton
                  disabled={!online.has(item.id) || organizationId === null}
                  label="Load advertised workspaces"
                  onPress={() => {
                    if (organizationId === null) return;
                    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                    void loadWorkspaceCatalog(apiBaseUrl, organizationId, item.id)
                      .then((items) => setCatalog((current) => ({ ...current, [item.id]: items })))
                      .catch((error: unknown) => setMessage(errorMessage(error)));
                  }}
                />
                {environmentCatalog.map((workspace) => (
                  <ActionButton
                    key={workspace.id}
                    label={`Bind ${workspace.name}`}
                    onPress={() => {
                      if (organizationId === null || projectId === null) return;
                      const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                      void bindWorkspace(
                        apiBaseUrl,
                        organizationId,
                        item.id,
                        projectId,
                        workspace.id,
                      )
                        .then(() => listWorkspaceBindings(apiBaseUrl, organizationId, projectId))
                        .then((items) => {
                          setBindings(items);
                          setSelectedEnvironmentId(item.id);
                          setSelectedWorkspaceId(workspace.id);
                        })
                        .catch((error: unknown) => setMessage(errorMessage(error)));
                    }}
                  />
                ))}
                {selectedEnvironmentId === item.id
                  ? (() => {
                      const binding = environmentBindings.find(
                        (candidate) => candidate.id === selectedWorkspaceId,
                      );
                      return binding === undefined ? (
                        <Text style={styles.muted}>
                          Select a project-authorized workspace to use execution capabilities.
                        </Text>
                      ) : (
                        <MobileExecutionConsole
                          active={activeExecution !== null}
                          disabled={
                            executionPending || !online.has(item.id) || organizationId === null
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
      {message === null ? null : <Text style={styles.muted}>{message}</Text>}
      {progress.length === 0 ? null : (
        <View style={styles.executionOutput}>
          <Text style={styles.label}>Streaming output · latest {progress.length} line(s)</Text>
          <Text selectable style={styles.muted}>
            {progress.join("")}
          </Text>
        </View>
      )}
      {result === null ? null : (
        <Text selectable style={styles.muted}>
          {JSON.stringify(result, null, 2)}
        </Text>
      )}
    </StateCard>
  );
};
