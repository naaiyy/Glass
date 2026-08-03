import { createOutboxEngine, type OutboxEnvelope } from "@glass/client-runtime/outbox";
import {
  GlassConnectClient,
  type ClientConnectSocket,
} from "@glass/client-runtime/glass-connect-client";
import { createSyncEngine } from "@glass/client-runtime/sync";
import { loadProductSnapshot } from "@glass/client-runtime/snapshot";
import type {
  ArtifactId,
  CommandId,
  ExecutionOperationId,
  OrganizationId,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { OrganizationMembershipItem } from "@glass/contracts/organizations";
import type { ProductSnapshot } from "@glass/contracts/sync";
import type { OpenEditorDocument } from "@openeditor/core";
import { OpenEditorNative, type OpenEditorNativeController } from "@openeditor/native";
import { NavigationContainer } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  mobileAuthenticatedFetch,
  signInWithGitHub as mobileSignInWithGitHub,
  signOut as mobileSignOut,
} from "./cloud/auth-client.ts";
import {
  createMobileOutboxStorage,
  createMobileProductStorage,
  clearActiveOrganization,
  loadActiveOrganization,
  loadOrganizationBootstrap,
  saveActiveOrganization,
  saveOrganizationBootstrap,
} from "./cloud/storage.ts";
import {
  createNoteMutation,
  createOrganizationBootstrapEnvelope,
  createProjectMutation,
} from "./cloud/product-mutations.ts";
import type { MobileCloudScope } from "./cloud/storage-keys.ts";
import {
  classifyProductTransportError,
  createProductTransport,
  drainThenSynchronize,
  isTransientProductFailure,
  isUnauthenticated,
  ProductProtocolError,
  requiresResnapshot,
  resolveApiBaseUrl,
} from "./cloud/transport.ts";
import {
  approveEnvironmentPairing,
  approveEnvironmentRotation,
  authorizeEnvironmentConnection,
  bindWorkspace,
  createFileList,
  listEnvironments,
  listWorkspaceBindings,
  loadExecutionOperation,
  loadEnvironmentPresence,
  loadWorkspaceCatalog,
  revokeEnvironment,
} from "./cloud/environments.ts";
import type { ExecutionEnvironment } from "@glass/contracts/environments";
import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";

type RootStack = {
  Artifact: { artifactId: string };
  Home: undefined;
  Note: { noteId: ArtifactId };
  Project: { projectId: string };
  Thread: { threadId: string };
};

type ProductPhase =
  | "checking-session"
  | "configuration-required"
  | "live"
  | "offline"
  | "product-only"
  | "signed-out"
  | "synchronizing";

type ProductView = Readonly<{
  authenticatedUserId: UserId | null;
  error: string | null;
  phase: ProductPhase;
  scope: MobileCloudScope | null;
  snapshot: ProductSnapshot | null;
}>;

type OutboxEngine = ReturnType<typeof createOutboxEngine>;

const Stack = createNativeStackNavigator<RootStack>();
const ProductSnapshotContext = createContext<ProductSnapshot | null>(null);
const ProductActionsContext = createContext<
  Readonly<{ createNote: (projectId: ProjectId, name: string) => Promise<ArtifactId> }> | undefined
>(undefined);

const initialView: ProductView = {
  authenticatedUserId: null,
  error: null,
  phase: "checking-session",
  scope: null,
  snapshot: null,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Glass Cloud is unavailable.";

const loadOfflineCache = async (
  authenticatedUserId: UserId,
  organizationId: OrganizationId,
): Promise<Pick<ProductView, "scope" | "snapshot">> => {
  const scope = { organizationId, userId: authenticatedUserId };
  let snapshot: ProductSnapshot | null = null;
  const storage = createMobileProductStorage(scope, (next) => {
    snapshot = next;
  });
  snapshot = await storage.loadSnapshot();
  return { scope, snapshot };
};

const useProductCloud = () => {
  const [view, setView] = useState<ProductView>(initialView);
  const [outbox, setOutbox] = useState<readonly OutboxEnvelope[]>([]);
  const [generation, setGeneration] = useState(0);
  const [organizations, setOrganizations] = useState<readonly OrganizationMembershipItem[]>([]);
  const [organizationsCursor, setOrganizationsCursor] = useState<OrganizationId | null>(null);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const outboxEngine = useRef<OutboxEngine | null>(null);
  const productStorage = useRef<ReturnType<typeof createMobileProductStorage> | null>(null);
  const syncEngine = useRef<ReturnType<typeof createSyncEngine> | null>(null);

  useEffect(() => {
    let active = true;
    let ownedOutboxEngine: OutboxEngine | null = null;
    let unsubscribeOutbox: (() => void) | undefined;
    let unsubscribeSync: (() => void) | undefined;

    const show = (next: ProductView) => {
      if (active) setView(next);
    };

    const runScoped = async (
      apiBaseUrl: string,
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<void> => {
      const scope = { userId, organizationId };
      const transport = createProductTransport(apiBaseUrl, mobileAuthenticatedFetch(apiBaseUrl));
      const storage = createMobileProductStorage(scope, (snapshot) => {
        if (active) setView((current) => ({ ...current, scope, snapshot }));
      });
      productStorage.current = storage;
      let snapshot = await storage.loadSnapshot();
      if (!active) return;
      show({ authenticatedUserId: userId, error: null, phase: "synchronizing", scope, snapshot });

      const engine = createOutboxEngine({
        classifyTransportError: classifyProductTransportError,
        clock: { now: () => Date.now() },
        onAccepted: () => {
          if (syncEngine.current === null) return;
          void syncEngine.current.synchronize().catch((error: unknown) => {
            if (!active) return;
            if (isUnauthenticated(error)) {
              show({
                authenticatedUserId: null,
                error: null,
                phase: "signed-out",
                scope: null,
                snapshot: null,
              });
            } else {
              setView((current) => ({
                ...current,
                error: errorMessage(error),
                phase: "offline",
              }));
            }
          });
        },
        random: { next: () => Math.random() },
        storage: createMobileOutboxStorage(scope),
        transport: transport.outboxTransport,
      });
      outboxEngine.current = engine;
      ownedOutboxEngine = engine;
      unsubscribeOutbox = engine.subscribe((items) => {
        if (!active) return;
        setOutbox(items);
        if (items.some((item) => item.attention?.code === "unauthenticated")) {
          show({
            authenticatedUserId: null,
            error: null,
            phase: "signed-out",
            scope: null,
            snapshot: null,
          });
          return;
        }
      });
      await engine.initialize();
      if (!active) return;
      for (const item of engine.getSnapshot()) {
        if (item.attention?.code === "unauthenticated") {
          // Session proof succeeded in this run, so access may be retried with the new session.
          // eslint-disable-next-line no-await-in-loop
          await engine.retry(item.mutation.commandId);
        }
      }

      await engine.drain();
      if (snapshot === null) {
        snapshot = await loadProductSnapshot({ organizationId, transport });
        if (!active) return;
        await storage.installSnapshot(snapshot);
        if (!active) return;
      }

      const synchronize = async (): Promise<void> => {
        if (!active) return;
        const sync = createSyncEngine({
          organizationId,
          storage: storage.syncStorage,
          transport: transport.syncTransport,
        });
        syncEngine.current = sync;
        unsubscribeSync?.();
        unsubscribeSync = sync.subscribe((state) => {
          if (!active) return;
          if (state.status === "synchronizing") {
            setView((current) => ({ ...current, phase: "synchronizing" }));
          }
        });
        await sync.initialize();
        await sync.synchronize();
      };

      try {
        await synchronize();
        if (!active) return;
      } catch (error) {
        if (!requiresResnapshot(error)) throw error;
        snapshot = await loadProductSnapshot({ organizationId, transport });
        if (!active) return;
        await storage.installSnapshot(snapshot);
        if (!active) return;
        await synchronize();
        if (!active) return;
      }
      snapshot = await storage.loadSnapshot();
      show({ authenticatedUserId: userId, error: null, phase: "live", scope, snapshot });
    };

    const run = async (): Promise<void> => {
      setOutbox([]);
      outboxEngine.current = null;
      let apiBaseUrl: string;
      try {
        apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
      } catch (error) {
        show({
          authenticatedUserId: null,
          error: errorMessage(error),
          phase: "configuration-required",
          scope: null,
          snapshot: null,
        });
        return;
      }

      const transport = createProductTransport(apiBaseUrl, mobileAuthenticatedFetch(apiBaseUrl));
      let userId: UserId;
      try {
        userId = (await transport.getAuthenticatedProof()).userId;
        if (!active) return;
      } catch (error) {
        if (isUnauthenticated(error)) {
          show({
            authenticatedUserId: null,
            error: null,
            phase: "signed-out",
            scope: null,
            snapshot: null,
          });
          return;
        }
        show({
          authenticatedUserId: null,
          error: errorMessage(error),
          phase: "offline",
          scope: null,
          snapshot: null,
        });
        return;
      }

      try {
        const page = await transport.listOrganizations(userId, { after: null, limit: 50 });
        if (!active) return;
        setOrganizations(page.items);
        setOrganizationsCursor(page.nextCursor);
        setOrganizationsError(null);
      } catch (error) {
        if (!active) return;
        setOrganizationsError(errorMessage(error));
      }

      let organizationId = await loadActiveOrganization(userId);
      if (!active) return;
      if (organizationId === null) {
        const bootstrap = await loadOrganizationBootstrap(userId);
        if (!active) return;
        if (bootstrap !== null) {
          organizationId = bootstrap.mutation.organizationId;
          await saveActiveOrganization(userId, organizationId);
          if (!active) return;
        }
      }
      if (organizationId === null) {
        show({
          authenticatedUserId: userId,
          error: null,
          phase: "product-only",
          scope: null,
          snapshot: null,
        });
        return;
      }
      try {
        await runScoped(apiBaseUrl, userId, organizationId);
      } catch (error) {
        if (isUnauthenticated(error)) {
          show({
            authenticatedUserId: null,
            error: null,
            phase: "signed-out",
            scope: null,
            snapshot: null,
          });
          return;
        }
        if (!isTransientProductFailure(error)) {
          const currentEngine = outboxEngine.current as OutboxEngine | null;
          const attention =
            currentEngine
              ?.getSnapshot()
              .some((item: OutboxEnvelope) => item.status === "needs-attention") ?? false;
          if (!attention) {
            setOutbox([]);
            await clearActiveOrganization(userId);
          }
          show({
            authenticatedUserId: userId,
            error: errorMessage(error),
            phase: "product-only",
            scope: attention ? { organizationId, userId } : null,
            snapshot: null,
          });
          return;
        }
        const cached = await loadOfflineCache(userId, organizationId);
        show({
          ...cached,
          authenticatedUserId: userId,
          error: errorMessage(error),
          phase: "offline",
        });
      }
    };

    void run().catch((error: unknown) => {
      show({
        authenticatedUserId: null,
        error: errorMessage(error),
        phase: "offline",
        scope: null,
        snapshot: null,
      });
    });
    return () => {
      active = false;
      unsubscribeOutbox?.();
      unsubscribeSync?.();
      ownedOutboxEngine?.dispose();
      if (outboxEngine.current === ownedOutboxEngine) outboxEngine.current = null;
      productStorage.current = null;
      syncEngine.current = null;
    };
  }, [generation]);

  const settleOutbox = async (): Promise<void> => {
    const engine = outboxEngine.current;
    if (engine === null) return;
    const sync = syncEngine.current;
    if (sync === null) await engine.drain();
    else await drainThenSynchronize(engine.drain, sync.synchronize);
  };

  return {
    bootstrapOrganization: async (name: string): Promise<void> => {
      const userId = view.authenticatedUserId;
      if (userId === null) throw new Error("A Glass Cloud session is required.");
      const created = createOrganizationBootstrapEnvelope(name, randomUUID);
      await saveOrganizationBootstrap(userId, created.envelope);
      await saveActiveOrganization(userId, created.organizationId);
      setGeneration((value) => value + 1);
    },
    createProject: async (name: string, description: string | null): Promise<ProjectId> => {
      const engine = outboxEngine.current;
      const sync = syncEngine.current;
      const storage = productStorage.current;
      const organizationId = view.scope?.organizationId;
      if (engine === null || sync === null || storage === null || organizationId === undefined) {
        throw new Error("Glass Cloud must be live before creating a project.");
      }
      const created = createProjectMutation({ description, name, organizationId }, randomUUID);
      await engine.enqueue(created.mutation);
      await drainThenSynchronize(engine.drain, sync.synchronize);
      if (
        engine.getSnapshot().some((item) => item.mutation.commandId === created.mutation.commandId)
      ) {
        throw new Error("The project is queued for Glass Cloud. Reconnect to finish creating it.");
      }
      const latest = await storage.loadSnapshot();
      if (latest?.projects.some((project) => project.id === created.projectId) !== true) {
        throw new Error("The created project is not in the confirmed snapshot yet.");
      }
      return created.projectId;
    },
    createNote: async (projectId: ProjectId, name: string): Promise<ArtifactId> => {
      const engine = outboxEngine.current;
      const sync = syncEngine.current;
      const storage = productStorage.current;
      const organizationId = view.scope?.organizationId;
      if (engine === null || sync === null || storage === null || organizationId === undefined) {
        throw new Error("Glass Cloud must be live before creating a note.");
      }
      const created = createNoteMutation({ name, organizationId, projectId }, randomUUID);
      await engine.enqueue(created.mutation);
      await drainThenSynchronize(engine.drain, sync.synchronize);
      if (
        engine.getSnapshot().some((item) => item.mutation.commandId === created.mutation.commandId)
      ) {
        throw new Error("The note is queued for Glass Cloud. Reconnect to finish creating it.");
      }
      const latest = await storage.loadSnapshot();
      if (
        latest?.artifacts.some(
          (artifact) => artifact.kind === "note" && artifact.id === created.noteId,
        ) !== true
      ) {
        throw new Error("The created note is not in the confirmed snapshot yet.");
      }
      return created.noteId;
    },
    outbox,
    organizations,
    organizationsCursor,
    organizationsError,
    loadMoreOrganizations: async () => {
      const userId = view.authenticatedUserId;
      if (userId === null || organizationsCursor === null) return;
      try {
        const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
        const page = await createProductTransport(
          apiBaseUrl,
          mobileAuthenticatedFetch(apiBaseUrl),
        ).listOrganizations(userId, {
          after: organizationsCursor,
          limit: 50,
        });
        setOrganizations((current) => [
          ...current,
          ...page.items.filter(
            (item) => !current.some((entry) => entry.organization.id === item.organization.id),
          ),
        ]);
        setOrganizationsCursor(page.nextCursor);
        setOrganizationsError(null);
      } catch (error) {
        setOrganizationsError(errorMessage(error));
      }
    },
    retry: () => setGeneration((value) => value + 1),
    signIn: async () => {
      const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
      await mobileSignInWithGitHub(apiBaseUrl);
      setGeneration((value) => value + 1);
    },
    signOut: async () => {
      const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
      await mobileSignOut(apiBaseUrl);
      setGeneration((value) => value + 1);
    },
    retryOutboxItem: async (commandId: CommandId) => {
      const engine = outboxEngine.current;
      const item = engine
        ?.getSnapshot()
        .find((candidate) => candidate.mutation.commandId === commandId);
      if (
        engine === null ||
        (item?.attention?.code !== "forbidden" && item?.attention?.code !== "not-found")
      )
        return;
      await engine.retry(commandId);
      await settleOutbox();
    },
    discardOutboxItem: async (commandId: CommandId) => {
      const engine = outboxEngine.current;
      if (engine === null) return;
      const item = engine
        .getSnapshot()
        .find((candidate) => candidate.mutation.commandId === commandId);
      await engine.discard(commandId);
      if (
        item?.mutation.operation.kind === "organization.create" &&
        view.authenticatedUserId !== null
      ) {
        await clearActiveOrganization(view.authenticatedUserId);
        setGeneration((value) => value + 1);
        return;
      }
      await settleOutbox();
    },
    selectOrganization: async (userId: UserId, value: string) => {
      const decoded = decodeId<OrganizationId>(value.trim(), "$organizationId");
      if (!decoded.ok)
        throw new ProductProtocolError("Enter a canonical organization UUID.", decoded.issues);
      await saveActiveOrganization(userId, decoded.value);
      setGeneration((current) => current + 1);
    },
    view,
  };
};

const StateCard = ({ children, title }: { children: ReactNode; title: string }) => (
  <View style={styles.stateCard}>
    <Text style={styles.stateTitle}>{title}</Text>
    {children}
  </View>
);

const ActionButton = ({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={[styles.button, disabled && styles.buttonDisabled]}
  >
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>
);

const ExecutionCard = ({
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
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [rotationCode, setRotationCode] = useState("");
  const [trustActionPending, setTrustActionPending] = useState(false);
  const [environmentGeneration, setEnvironmentGeneration] = useState(0);
  const connection = useRef<GlassConnectClient | null>(null);
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
                    onPress={() => setSelectedWorkspaceId(binding.id)}
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
                          setSelectedWorkspaceId(workspace.id);
                        })
                        .catch((error: unknown) => setMessage(errorMessage(error)));
                    }}
                  />
                ))}
                <ActionButton
                  disabled={!online.has(item.id) || organizationId === null}
                  label="Connect"
                  onPress={() => {
                    if (organizationId === null || projectId === null) return;
                    const binding =
                      environmentBindings.find(
                        (candidate) => candidate.id === selectedWorkspaceId,
                      ) ?? environmentBindings[0];
                    if (binding === undefined) {
                      setMessage(
                        "An administrator must bind an advertised workspace to this project first.",
                      );
                      return;
                    }
                    const apiBaseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL);
                    const operationId = randomUUID() as ExecutionOperationId;
                    const requestId = randomUUID();
                    void createFileList(
                      apiBaseUrl,
                      organizationId,
                      item.id,
                      projectId,
                      binding.id,
                      operationId,
                      requestId,
                    )
                      .then((dispatch) => {
                        connection.current?.stop();
                        let dispatched = false;
                        const client = new GlassConnectClient({
                          environmentIdentity: {
                            id: item.id,
                            keyVersion: item.keyVersion,
                            organizationId: item.organizationId,
                            publicKey: item.publicKey,
                          },
                          getTicket: (clientNonce) =>
                            authorizeEnvironmentConnection(
                              apiBaseUrl,
                              organizationId,
                              item.id,
                              clientNonce,
                            ),
                          makeSocket: (ticket) =>
                            new WebSocket(ticket.websocketUrl, [
                              "glass-connect-v2",
                              `glass-ticket.${ticket.ticket}`,
                            ]) as unknown as ClientConnectSocket,
                          onFrame: (frame) => {
                            if (frame.type === "operation.error") setMessage(frame.error.message);
                            else if (frame.event === "progress")
                              setMessage("The execution node is streaming progress.");
                            else {
                              setResult(frame.payload);
                              setMessage("Authorized workspace listing completed.");
                            }
                          },
                          onOnline: () => {
                            void (async () => {
                              if (dispatched) {
                                const durable = await loadExecutionOperation(
                                  apiBaseUrl,
                                  operationId,
                                );
                                if (["succeeded", "failed", "cancelled"].includes(durable.status)) {
                                  setResult(durable.result ?? durable.error);
                                  setMessage(`Durable execution state: ${durable.status}.`);
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
                                capability: "file.list",
                                dispatchGrant: dispatch.dispatchGrant,
                                payload: {
                                  operation: "file.list",
                                  workspaceId: binding.id,
                                  path: ".",
                                },
                              });
                              if (dispatched)
                                setMessage(
                                  "Connected through Glass Connect. Listing the authorized workspace root…",
                                );
                            })().catch((error: unknown) => setMessage(errorMessage(error)));
                          },
                          onStatus: (status) => {
                            if (status.status === "reconnecting") {
                              setMessage(
                                "Execution is reconnecting. Cloud product access remains available.",
                              );
                              void loadExecutionOperation(apiBaseUrl, operationId)
                                .then((operation) => {
                                  setResult(operation.result ?? operation.error);
                                  setMessage(
                                    `Durable execution state: ${operation.status}. Reconnecting…`,
                                  );
                                })
                                .catch(() => undefined);
                            }
                          },
                        });
                        connection.current = client;
                        client.start();
                      })
                      .catch((error: unknown) => setMessage(errorMessage(error)));
                  }}
                />
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
      {result === null ? null : (
        <Text selectable style={styles.muted}>
          {JSON.stringify(result, null, 2)}
        </Text>
      )}
    </StateCard>
  );
};

type HomeProps = NativeStackScreenProps<RootStack, "Home"> &
  Readonly<{
    bootstrapOrganization: (name: string) => Promise<void>;
    createProject: (name: string, description: string | null) => Promise<ProjectId>;
    discardOutboxItem: (commandId: CommandId) => Promise<void>;
    loadMoreOrganizations: () => Promise<void>;
    organizations: readonly OrganizationMembershipItem[];
    organizationsCursor: OrganizationId | null;
    organizationsError: string | null;
    outbox: readonly OutboxEnvelope[];
    retry: () => void;
    retryOutboxItem: (commandId: CommandId) => Promise<void>;
    selectOrganization: (userId: UserId, value: string) => Promise<void>;
    signIn: () => Promise<void>;
    signOut: () => Promise<void>;
    view: ProductView;
  }>;

const HomeScreen = ({
  bootstrapOrganization,
  createProject,
  discardOutboxItem,
  loadMoreOrganizations,
  navigation,
  organizations,
  organizationsCursor,
  organizationsError,
  outbox,
  retry,
  retryOutboxItem,
  selectOrganization,
  signIn,
  signOut,
  view,
}: HomeProps) => {
  const [organizationInput, setOrganizationInput] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const attention = outbox.filter((item) => item.status === "needs-attention");
  const pending = outbox.length - attention.length;
  const snapshot = view.snapshot;
  const authenticatedUserId = view.authenticatedUserId;

  const chooseOrganization = async () => {
    if (view.authenticatedUserId === null) return;
    setInputError(null);
    try {
      await selectOrganization(view.authenticatedUserId, organizationInput);
    } catch (error) {
      setInputError(errorMessage(error));
    }
  };

  const runCloudAction = (action: Promise<void>) => {
    void action.catch((error: unknown) => setInputError(errorMessage(error)));
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>GLASS · MOBILE</Text>
      <Text style={styles.title}>Your cloud workspace</Text>

      {view.phase === "configuration-required" ? (
        <StateCard title="Cloud configuration required">
          <Text style={styles.body}>{view.error}</Text>
          <Text style={styles.muted}>
            Set EXPO_PUBLIC_GLASS_API_URL to the Glass Cloud API origin.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "checking-session" ? (
        <StateCard title="Checking Glass Cloud session">
          <ActivityIndicator color="#8de0bd" />
        </StateCard>
      ) : null}

      {view.phase === "signed-out" ? (
        <StateCard title="Welcome to Glass">
          <Text style={styles.body}>
            Sign in to open your organizations, conversations, notes, and artifacts. Execution
            access remains separate and optional.
          </Text>
          <ActionButton
            disabled={authPending}
            label={authPending ? "Opening GitHub…" : "Continue with GitHub"}
            onPress={() => {
              setInputError(null);
              setAuthPending(true);
              void signIn()
                .catch((error: unknown) => setInputError(errorMessage(error)))
                .finally(() => setAuthPending(false));
            }}
          />
          {inputError === null ? null : <Text style={styles.error}>{inputError}</Text>}
        </StateCard>
      ) : null}

      {view.phase === "product-only" && authenticatedUserId !== null ? (
        <StateCard title="Product connection ready">
          {view.error === null ? null : <Text style={styles.error}>{view.error}</Text>}
          <Text style={styles.body}>Choose one of your organizations or create a new one.</Text>
          {organizations.map((item) => (
            <ActionButton
              key={item.organization.id}
              label={`${item.organization.name} · ${item.membership.role}`}
              onPress={() =>
                runCloudAction(selectOrganization(authenticatedUserId, item.organization.id))
              }
            />
          ))}
          {organizationsCursor === null ? null : (
            <ActionButton
              label="Load more organizations"
              onPress={() => void loadMoreOrganizations()}
            />
          )}
          {organizationsError === null ? null : (
            <Text style={styles.error}>{organizationsError}</Text>
          )}
          <TextInput
            autoCorrect={false}
            onChangeText={setOrganizationName}
            placeholder="New organization name"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={organizationName}
          />
          <ActionButton
            disabled={creating}
            label={creating ? "Creating…" : "Create organization"}
            onPress={() => {
              const name = organizationName.trim();
              if (name.length === 0) {
                setInputError("Enter an organization name.");
                return;
              }
              setCreating(true);
              setInputError(null);
              void bootstrapOrganization(name)
                .catch((error: unknown) => setInputError(errorMessage(error)))
                .finally(() => setCreating(false));
            }}
          />
          <Text style={styles.advancedLabel}>Advanced: open by organization UUID</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setOrganizationInput}
            placeholder="Organization UUID"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={organizationInput}
          />
          {inputError === null ? null : <Text style={styles.error}>{inputError}</Text>}
          <ActionButton label="Open organization" onPress={() => void chooseOrganization()} />
        </StateCard>
      ) : null}

      {view.phase === "synchronizing" ? (
        <StateCard title="Synchronizing product state">
          <ActivityIndicator color="#8de0bd" />
          <Text style={styles.muted}>
            Cached records remain distinct from cloud-confirmed updates.
          </Text>
        </StateCard>
      ) : null}

      {view.phase === "offline" ? (
        <StateCard title="Product connection offline">
          <Text style={styles.body}>{view.error ?? "Glass Cloud is unreachable."}</Text>
          <Text style={styles.muted}>
            {snapshot === null
              ? "No validated cache is available."
              : "Showing the last validated device cache."}
          </Text>
          <ActionButton label="Reconnect" onPress={retry} />
        </StateCard>
      ) : null}

      {view.phase === "live" ? (
        <StateCard title="Product connection live">
          <Text style={styles.muted}>Cloud-confirmed through cursor {snapshot?.cursor ?? "0"}</Text>
        </StateCard>
      ) : null}

      {view.phase !== "product-only" && authenticatedUserId !== null ? (
        <StateCard title="Your organizations">
          {organizations.map((item) => (
            <ActionButton
              key={item.organization.id}
              label={`${item.organization.name} · ${item.membership.role}${
                item.organization.id === view.scope?.organizationId ? " · active" : ""
              }`}
              onPress={() =>
                runCloudAction(selectOrganization(authenticatedUserId, item.organization.id))
              }
            />
          ))}
          {organizationsCursor === null ? null : (
            <ActionButton
              label="Load more organizations"
              onPress={() => void loadMoreOrganizations()}
            />
          )}
          {organizationsError === null ? null : (
            <Text style={styles.error}>{organizationsError}</Text>
          )}
        </StateCard>
      ) : null}

      {attention.length > 0 ? (
        <StateCard title="Outbox needs attention">
          {attention.map((item) => (
            <View key={item.mutation.commandId} style={styles.attentionItem}>
              <Text style={styles.error}>
                {item.mutation.operation.kind}: {item.attention?.message}
              </Text>
              {item.attention?.code === "forbidden" || item.attention?.code === "not-found" ? (
                <ActionButton
                  label="Retry after access changes"
                  onPress={() => runCloudAction(retryOutboxItem(item.mutation.commandId))}
                />
              ) : null}
              <ActionButton
                label="Discard command"
                onPress={() => runCloudAction(discardOutboxItem(item.mutation.commandId))}
              />
            </View>
          ))}
        </StateCard>
      ) : pending > 0 ? (
        <StateCard title="Outbox pending">
          <Text style={styles.body}>{pending} durable command(s) waiting for Glass Cloud.</Text>
        </StateCard>
      ) : null}

      <ExecutionCard
        organizationId={view.scope?.organizationId ?? null}
        projects={snapshot?.projects ?? []}
      />

      {authenticatedUserId === null ? null : (
        <ActionButton label="Sign out of Glass Cloud" onPress={() => runCloudAction(signOut())} />
      )}

      {snapshot === null ? null : (
        <>
          <View style={styles.summaryHeader}>
            <Text style={styles.sectionTitle}>{snapshot.organization.name}</Text>
            <Text style={styles.muted}>{snapshot.members.length} active member(s)</Text>
          </View>
          <TextInput
            autoCorrect={false}
            maxLength={240}
            onChangeText={setProjectName}
            placeholder="New project name"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={projectName}
          />
          <TextInput
            autoCorrect={false}
            maxLength={4000}
            onChangeText={setProjectDescription}
            placeholder="Project description (optional)"
            placeholderTextColor="#71817a"
            style={styles.input}
            value={projectDescription}
          />
          <ActionButton
            disabled={creating}
            label={creating ? "Creating…" : "Create project"}
            onPress={() => {
              const name = projectName.trim();
              if (name.length === 0) {
                setInputError("Enter a project name.");
                return;
              }
              setCreating(true);
              setInputError(null);
              void createProject(name, projectDescription.trim() || null)
                .then(() => {
                  setProjectName("");
                  setProjectDescription("");
                })
                .catch((error: unknown) => setInputError(errorMessage(error)))
                .finally(() => setCreating(false));
            }}
          />
          {snapshot.projects.map((project) => (
            <Pressable
              accessibilityRole="button"
              key={project.id}
              onPress={() => navigation.navigate("Project", { projectId: project.id })}
              style={styles.listCard}
            >
              <Text style={styles.listTitle}>{project.name}</Text>
              <Text numberOfLines={2} style={styles.muted}>
                {project.description ?? "No description"}
              </Text>
            </Pressable>
          ))}
        </>
      )}
      <StatusBar />
    </ScrollView>
  );
};

const DetailLayout = ({ children, title }: { children: ReactNode; title: string }) => (
  <ScrollView contentContainerStyle={styles.screen}>
    <Text style={styles.eyebrow}>GLASS CLOUD</Text>
    <Text style={styles.detailTitle}>{title}</Text>
    {children}
  </ScrollView>
);

const ProjectScreen = ({ navigation, route }: NativeStackScreenProps<RootStack, "Project">) => {
  const snapshot = useContext(ProductSnapshotContext);
  const actions = useContext(ProductActionsContext);
  const [noteName, setNoteName] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [creatingNote, setCreatingNote] = useState(false);
  const project = snapshot?.projects.find((item) => item.id === route.params.projectId);
  if (snapshot === null || project === undefined)
    return (
      <DetailLayout title="Project unavailable">
        <Text style={styles.body}>This project is not in the validated projection.</Text>
      </DetailLayout>
    );
  const threads = snapshot.threads.filter((item) => item.projectId === project.id);
  const artifacts = snapshot.artifacts.filter((item) => item.projectId === project.id);
  const notes = artifacts.filter((item): item is NoteArtifact => item.kind === "note");
  const outputs = artifacts.filter((item) => item.kind === "agent-output");
  return (
    <DetailLayout title={project.name}>
      <Text style={styles.body}>{project.description ?? "No description"}</Text>
      <Text style={styles.sectionTitle}>Threads</Text>
      {threads.map((item) => (
        <ActionButton
          key={item.id}
          label={item.title ?? "Untitled thread"}
          onPress={() => navigation.navigate("Thread", { threadId: item.id })}
        />
      ))}
      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        autoCorrect={false}
        editable={!creatingNote && actions !== undefined}
        maxLength={240}
        onChangeText={setNoteName}
        placeholder="New note name"
        placeholderTextColor="#71817a"
        style={styles.input}
        value={noteName}
      />
      {noteError === null ? null : <Text style={styles.error}>{noteError}</Text>}
      <ActionButton
        disabled={creatingNote || actions === undefined}
        label={creatingNote ? "Creating…" : "Create note"}
        onPress={() => {
          const name = noteName.trim();
          if (name.length === 0 || actions === undefined) {
            setNoteError("Enter a note name while Glass Cloud is live.");
            return;
          }
          setCreatingNote(true);
          setNoteError(null);
          void actions
            .createNote(project.id, name)
            .then((noteId) => {
              setNoteName("");
              navigation.navigate("Note", { noteId });
            })
            .catch((error: unknown) => setNoteError(errorMessage(error)))
            .finally(() => setCreatingNote(false));
        }}
      />
      {notes.length === 0 ? <Text style={styles.muted}>No notes yet.</Text> : null}
      {notes.map((item) => (
        <ActionButton
          key={item.id}
          label={item.icon === null ? item.name : `${item.icon} ${item.name}`}
          onPress={() => navigation.navigate("Note", { noteId: item.id })}
        />
      ))}
      <Text style={styles.sectionTitle}>Artifacts</Text>
      {outputs.map((item) => (
        <ActionButton
          key={item.id}
          label={item.name}
          onPress={() => navigation.navigate("Artifact", { artifactId: item.id })}
        />
      ))}
    </DetailLayout>
  );
};

const ThreadScreen = ({ route }: NativeStackScreenProps<RootStack, "Thread">) => {
  const snapshot = useContext(ProductSnapshotContext);
  const thread = snapshot?.threads.find((item) => item.id === route.params.threadId);
  const messages =
    snapshot?.messages.filter((item) => item.threadId === route.params.threadId) ?? [];
  return (
    <DetailLayout title={thread?.title ?? "Thread"}>
      <Text style={styles.muted}>{messages.length} message(s)</Text>
      {messages.map((message) => (
        <View key={message.id} style={styles.listCard}>
          <Text style={styles.body}>{message.body}</Text>
          <Text style={styles.muted}>Author {message.authorUserId.slice(0, 8)}</Text>
        </View>
      ))}
    </DetailLayout>
  );
};

const ArtifactScreen = ({ route }: NativeStackScreenProps<RootStack, "Artifact">) => {
  const snapshot = useContext(ProductSnapshotContext);
  const artifact = snapshot?.artifacts.find((item) => item.id === route.params.artifactId);
  return (
    <DetailLayout title={artifact?.name ?? "Artifact unavailable"}>
      <Text style={styles.muted}>{artifact?.kind ?? "Unknown kind"}</Text>
      <Text style={styles.body}>
        {artifact === undefined || artifact.kind !== "agent-output"
          ? "This artifact is not in the validated projection."
          : JSON.stringify(artifact.body, null, 2)}
      </Text>
    </DetailLayout>
  );
};

type NoteLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ error: string; status: "error" }>
  | Readonly<{ content: OpenEditorDocument; status: "ready" }>;

type NoteSaveState =
  | Readonly<{ status: "saved" }>
  | Readonly<{ status: "saving" }>
  | Readonly<{ error: string; status: "error" }>;

const NoteScreen = ({ navigation, route }: NativeStackScreenProps<RootStack, "Note">) => {
  const snapshot = useContext(ProductSnapshotContext);
  const note = snapshot?.artifacts.find(
    (item): item is NoteArtifact => item.kind === "note" && item.id === route.params.noteId,
  );
  const noteId = note?.id;
  const noteOrganizationId = note?.organizationId;
  const apiBaseUrl = useMemo(() => resolveApiBaseUrl(process.env.EXPO_PUBLIC_GLASS_API_URL), []);
  const transport = useMemo(
    () => createProductTransport(apiBaseUrl, mobileAuthenticatedFetch(apiBaseUrl)),
    [apiBaseUrl],
  );
  const controller = useRef<OpenEditorNativeController>(null);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [loadState, setLoadState] = useState<NoteLoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<NoteSaveState>({ status: "saved" });
  const pendingRevision = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const flushInFlight = useRef<Promise<void> | null>(null);
  const allowLeave = useRef(false);

  useEffect(() => {
    let active = true;
    if (noteId === undefined || noteOrganizationId === undefined) {
      setLoadState({
        error: "This note is not in the validated product snapshot.",
        status: "error",
      });
      return () => {
        active = false;
      };
    }
    setLoadState({ status: "loading" });
    void transport
      .loadNoteContent(noteOrganizationId, noteId)
      .then((response) => {
        if (active) setLoadState({ content: response.content, status: "ready" });
      })
      .catch((error: unknown) => {
        if (active) setLoadState({ error: errorMessage(error), status: "error" });
      });
    return () => {
      active = false;
    };
  }, [loadGeneration, noteId, noteOrganizationId, transport]);

  const savePending = useCallback(async (): Promise<void> => {
    if (noteId === undefined || noteOrganizationId === undefined) return;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flushInFlight.current !== null) return flushInFlight.current;
    if (inFlight.current !== null) return inFlight.current;
    const run = async (): Promise<void> => {
      const revision = pendingRevision.current;
      if (revision === null) {
        setSaveState({ status: "saved" });
        return;
      }
      pendingRevision.current = null;
      setSaveState({ status: "saving" });
      try {
        const current = await controller.current?.getDocument({ minimumRevision: revision });
        if (current === undefined) throw new Error("The note editor is not ready.");
        await transport.saveNoteContent({
          content: current.document,
          noteId,
          organizationId: noteOrganizationId,
        });
      } catch (error) {
        pendingRevision.current = Math.max(pendingRevision.current ?? 0, revision);
        setSaveState({ error: errorMessage(error), status: "error" });
        return;
      }
      return run();
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, [noteId, noteOrganizationId, transport]);

  const flush = useCallback((): Promise<void> => {
    if (noteId === undefined || noteOrganizationId === undefined || controller.current === null) {
      return Promise.resolve();
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flushInFlight.current !== null) return flushInFlight.current;
    const run = async (): Promise<void> => {
      await inFlight.current;
      const current = await controller.current?.flushDocument();
      if (current === undefined) throw new Error("The note editor is not ready.");
      setSaveState({ status: "saving" });
      try {
        await transport.saveNoteContent({
          content: current.document,
          noteId,
          organizationId: noteOrganizationId,
        });
      } catch (error) {
        pendingRevision.current = Math.max(pendingRevision.current ?? 0, current.revision);
        setSaveState({ error: errorMessage(error), status: "error" });
        throw error;
      }
      if (pendingRevision.current !== null && pendingRevision.current <= current.revision) {
        pendingRevision.current = null;
      }
      if (pendingRevision.current !== null) return run();
      setSaveState({ status: "saved" });
    };
    flushInFlight.current = run().finally(() => {
      flushInFlight.current = null;
    });
    return flushInFlight.current;
  }, [noteId, noteOrganizationId, transport]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        void flush().catch((error: unknown) =>
          setSaveState({ error: errorMessage(error), status: "error" }),
        );
    });
    return () => subscription.remove();
  }, [flush]);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (allowLeave.current || controller.current === null) return;
        event.preventDefault();
        void flush()
          .then(() => {
            allowLeave.current = true;
            navigation.dispatch(event.data.action);
          })
          .catch((error: unknown) => setSaveState({ error: errorMessage(error), status: "error" }));
      }),
    [flush, navigation],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  if (note === undefined) {
    return (
      <View style={styles.noteState}>
        <Text style={styles.error}>This note is not in the validated product snapshot.</Text>
      </View>
    );
  }

  return (
    <View style={styles.noteScreen}>
      <View style={styles.noteStatusRow}>
        <Text numberOfLines={1} style={styles.noteTitle}>
          {note.icon === null ? note.name : `${note.icon} ${note.name}`}
        </Text>
        <Text style={saveState.status === "error" ? styles.error : styles.muted}>
          {saveState.status === "saved" ? "Saved" : null}
          {saveState.status === "saving" ? "Saving…" : null}
          {saveState.status === "error" ? saveState.error : null}
        </Text>
      </View>
      {saveState.status === "error" ? (
        <ActionButton
          label="Retry save"
          onPress={() =>
            void flush().catch((error: unknown) =>
              setSaveState({ error: errorMessage(error), status: "error" }),
            )
          }
        />
      ) : null}
      {loadState.status === "loading" ? (
        <View style={styles.noteState}>
          <ActivityIndicator color="#8de0bd" />
          <Text style={styles.muted}>Loading note…</Text>
        </View>
      ) : null}
      {loadState.status === "error" ? (
        <View style={styles.noteState}>
          <Text style={styles.error}>{loadState.error}</Text>
          <ActionButton
            label="Retry load"
            onPress={() => setLoadGeneration((value) => value + 1)}
          />
        </View>
      ) : null}
      {loadState.status === "ready" ? (
        <OpenEditorNative
          initialDocument={loadState.content}
          key={note.id}
          onDocumentChanged={({ documentRevision }) => {
            pendingRevision.current = Math.max(pendingRevision.current ?? 0, documentRevision);
            setSaveState({ status: "saving" });
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => void savePending(), 800);
          }}
          onError={(error) => setSaveState({ error: error.message, status: "error" })}
          placeholder="Start writing…"
          ref={controller}
          style={styles.noteEditor}
        />
      ) : null}
    </View>
  );
};

export const App = () => {
  const cloud = useProductCloud();
  const productActions = useMemo(() => ({ createNote: cloud.createNote }), [cloud.createNote]);
  return (
    <ProductActionsContext.Provider value={productActions}>
      <ProductSnapshotContext.Provider value={cloud.view.snapshot}>
        <NavigationContainer>
          <Stack.Navigator
            screenOptions={{
              contentStyle: styles.navigation,
              headerStyle: styles.navigation,
              headerTintColor: "#eaf0ed",
            }}
          >
            <Stack.Screen name="Home" options={{ headerShown: false }}>
              {(props) => <HomeScreen {...props} {...cloud} />}
            </Stack.Screen>
            <Stack.Screen component={ProjectScreen} name="Project" />
            <Stack.Screen component={ThreadScreen} name="Thread" />
            <Stack.Screen component={ArtifactScreen} name="Artifact" />
            <Stack.Screen component={NoteScreen} name="Note" />
          </Stack.Navigator>
        </NavigationContainer>
      </ProductSnapshotContext.Provider>
    </ProductActionsContext.Provider>
  );
};

const styles = StyleSheet.create({
  advancedLabel: { color: "#91a19a", fontSize: 13, fontWeight: "700", marginTop: 20 },
  attentionItem: {
    borderTopColor: "#614f2a",
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 4,
  },
  body: { color: "#d9e2de", fontSize: 16, lineHeight: 24 },
  button: {
    backgroundColor: "#22312c",
    borderRadius: 12,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  buttonText: { color: "#b9f2d8", fontSize: 15, fontWeight: "700" },
  buttonDisabled: { opacity: 0.55 },
  connectionRow: {
    alignItems: "center",
    borderColor: "#2b3a35",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 16,
    padding: 18,
  },
  connectionStatus: { color: "#8de0bd", fontSize: 13, fontWeight: "700" },
  detailTitle: {
    color: "#eaf0ed",
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -1.2,
    marginBottom: 20,
    marginTop: 8,
  },
  error: { color: "#ffaaa3", fontSize: 14, lineHeight: 21, marginTop: 8 },
  eyebrow: { color: "#8de0bd", fontSize: 12, fontWeight: "700", letterSpacing: 2 },
  input: {
    backgroundColor: "#0c1212",
    borderColor: "#40534b",
    borderRadius: 12,
    borderWidth: 1,
    color: "#eaf0ed",
    fontSize: 15,
    marginTop: 14,
    padding: 14,
  },
  label: { color: "#eaf0ed", fontSize: 15, fontWeight: "700" },
  listCard: { backgroundColor: "#17211e", borderRadius: 14, marginTop: 10, padding: 16 },
  listTitle: { color: "#f0f5f2", fontSize: 18, fontWeight: "700", marginBottom: 4 },
  muted: { color: "#91a19a", fontSize: 14, lineHeight: 21, marginTop: 4 },
  navigation: { backgroundColor: "#101617" },
  noteEditor: { flex: 1 },
  noteScreen: { backgroundColor: "#f8faf9", flex: 1 },
  noteState: { alignItems: "center", flex: 1, justifyContent: "center", padding: 24 },
  noteStatusRow: {
    alignItems: "center",
    borderBottomColor: "#dce4e0",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
    paddingHorizontal: 16,
  },
  noteTitle: { color: "#18201d", flex: 1, fontSize: 17, fontWeight: "700", marginRight: 12 },
  screen: { backgroundColor: "#101617", flexGrow: 1, padding: 24, paddingBottom: 64 },
  sectionTitle: { color: "#eaf0ed", fontSize: 20, fontWeight: "700", marginTop: 24 },
  stateCard: {
    backgroundColor: "#17211e",
    borderColor: "#2b3a35",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 18,
    padding: 18,
  },
  stateTitle: { color: "#eaf0ed", fontSize: 19, fontWeight: "700", marginBottom: 8 },
  summaryHeader: { marginTop: 18 },
  title: {
    color: "#eaf0ed",
    fontSize: 42,
    fontWeight: "700",
    letterSpacing: -1.8,
    lineHeight: 45,
    marginTop: 12,
  },
});
