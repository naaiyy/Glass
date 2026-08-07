import { createOutboxEngine, type OutboxEnvelope } from "@glass/client-runtime/outbox";
import { loadProductSnapshot } from "@glass/client-runtime/snapshot";
import { createSyncEngine } from "@glass/client-runtime/sync";
import type {
  ArtifactId,
  CommandId,
  OrganizationId,
  ProjectId,
  UserId,
} from "@glass/contracts/ids";
import type { OrganizationMembershipItem } from "@glass/contracts/organizations";
import type { ProductSnapshot } from "@glass/contracts/sync";
import { randomUUID } from "expo-crypto";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  mobileAuthenticatedFetch,
  signInWithGitHub as mobileSignInWithGitHub,
  signOut as mobileSignOut,
} from "../cloud/auth-client.ts";
import {
  createNoteMutation,
  createOrganizationBootstrapEnvelope,
  createProjectMutation,
} from "../cloud/product-mutations.ts";
import {
  clearActiveOrganization,
  createMobileOutboxStorage,
  createMobileProductStorage,
  loadActiveOrganization,
  loadOrganizationBootstrap,
  saveActiveOrganization,
  saveOrganizationBootstrap,
} from "../cloud/storage.ts";
import type { MobileCloudScope } from "../cloud/storage-keys.ts";
import {
  classifyProductTransportError,
  createProductTransport,
  drainThenSynchronize,
  isTransientProductFailure,
  isUnauthenticated,
  requiresResnapshot,
  resolveApiBaseUrl,
} from "../cloud/transport.ts";
import { errorMessage } from "../lib/errors.ts";

export type ProductPhase =
  | "checking-session"
  | "configuration-required"
  | "live"
  | "offline"
  | "organization-selection"
  | "signed-out"
  | "synchronizing";

export type ProductView = Readonly<{
  authenticatedUserId: UserId | null;
  error: string | null;
  phase: ProductPhase;
  scope: MobileCloudScope | null;
  snapshot: ProductSnapshot | null;
}>;

type OutboxEngine = ReturnType<typeof createOutboxEngine>;

const initialView: ProductView = {
  authenticatedUserId: null,
  error: null,
  phase: "checking-session",
  scope: null,
  snapshot: null,
};

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

const useProductCloudRuntime = () => {
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
          phase: "organization-selection",
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
            phase: "organization-selection",
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
      setOutbox([]);
      setView({
        authenticatedUserId: userId,
        error: null,
        phase: "checking-session",
        scope: null,
        snapshot: null,
      });
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
      setOutbox([]);
      setView({
        authenticatedUserId: null,
        error: null,
        phase: "signed-out",
        scope: null,
        snapshot: null,
      });
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
    selectOrganization: async (userId: UserId, organizationId: OrganizationId) => {
      await saveActiveOrganization(userId, organizationId);
      setOutbox([]);
      setView({
        authenticatedUserId: userId,
        error: null,
        phase: "checking-session",
        scope: null,
        snapshot: null,
      });
      setGeneration((current) => current + 1);
    },
    view,
  };
};

export type MobileCloud = ReturnType<typeof useProductCloudRuntime>;

export type ProductCloudState = Pick<
  MobileCloud,
  "organizations" | "organizationsCursor" | "organizationsError" | "outbox" | "view"
>;
export type ProductCloudActions = Omit<MobileCloud, keyof ProductCloudState>;

const ProductCloudStateContext = createContext<ProductCloudState | null>(null);
const ProductCloudActionsContext = createContext<ProductCloudActions | null>(null);

export const ProductCloudProvider = ({ children }: Readonly<{ children: ReactNode }>) => {
  const cloud = useProductCloudRuntime();
  const state = useMemo<ProductCloudState>(
    () => ({
      organizations: cloud.organizations,
      organizationsCursor: cloud.organizationsCursor,
      organizationsError: cloud.organizationsError,
      outbox: cloud.outbox,
      view: cloud.view,
    }),
    [
      cloud.organizations,
      cloud.organizationsCursor,
      cloud.organizationsError,
      cloud.outbox,
      cloud.view,
    ],
  );
  const actions = useMemo<ProductCloudActions>(
    () => ({
      bootstrapOrganization: cloud.bootstrapOrganization,
      createNote: cloud.createNote,
      createProject: cloud.createProject,
      discardOutboxItem: cloud.discardOutboxItem,
      loadMoreOrganizations: cloud.loadMoreOrganizations,
      retry: cloud.retry,
      retryOutboxItem: cloud.retryOutboxItem,
      selectOrganization: cloud.selectOrganization,
      signIn: cloud.signIn,
      signOut: cloud.signOut,
    }),
    [
      cloud.bootstrapOrganization,
      cloud.createNote,
      cloud.createProject,
      cloud.discardOutboxItem,
      cloud.loadMoreOrganizations,
      cloud.retry,
      cloud.retryOutboxItem,
      cloud.selectOrganization,
      cloud.signIn,
      cloud.signOut,
    ],
  );
  return (
    <ProductCloudActionsContext.Provider value={actions}>
      <ProductCloudStateContext.Provider value={state}>
        {children}
      </ProductCloudStateContext.Provider>
    </ProductCloudActionsContext.Provider>
  );
};

export const useProductCloudState = (): ProductCloudState => {
  const state = useContext(ProductCloudStateContext);
  if (state === null) throw new Error("Mobile product cloud state is unavailable.");
  return state;
};

export const useProductCloudActions = (): ProductCloudActions => {
  const actions = useContext(ProductCloudActionsContext);
  if (actions === null) throw new Error("Mobile product cloud actions are unavailable.");
  return actions;
};

export const useMobileCloud = (): MobileCloud => {
  const state = useProductCloudState();
  const actions = useProductCloudActions();
  return useMemo(() => ({ ...actions, ...state }), [actions, state]);
};
