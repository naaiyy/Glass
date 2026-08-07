import { createOutboxEngine, type OutboxEnvelope } from "@glass/client-runtime/outbox";
import { loadProductSnapshot } from "@glass/client-runtime/snapshot";
import { createSyncEngine, type ProductSyncState } from "@glass/client-runtime/sync";
import type { CommandId, OrganizationId, ProjectId, UserId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { ProductSnapshot } from "@glass/contracts/sync";
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

import { signOut as signOutSession } from "../auth-client.ts";
import {
  clearActiveOrganization,
  IndexedDbProductStorage,
  loadActiveOrganization,
  loadOrganizationBootstrap,
  saveActiveOrganization,
  saveOrganizationBootstrap,
} from "./indexed-db.ts";
import {
  createNoteMutation,
  createOrganizationBootstrapEnvelope,
  createProjectMutation,
} from "./product-mutations.ts";
import {
  classifyProductTransportError,
  createProductCloudTransport,
  drainThenSynchronize,
  ProductCloudRequestError,
  synchronizeFromCheckpoint,
} from "./transport.ts";

export type ProductViewState =
  | Readonly<{ status: "checking-session" }>
  | Readonly<{ status: "signed-out" }>
  | Readonly<{ error: string | null; status: "organization-selection"; userId: UserId }>
  | Readonly<{ error: string; snapshot: null; status: "offline" }>
  | Readonly<{
      error: string | null;
      snapshot: ProductSnapshot | null;
      status: "cached" | "live" | "offline" | "synchronizing";
      userId: UserId;
    }>;

export type ProductCloudContextValue = Readonly<{
  bootstrapOrganization: (name: string) => Promise<void>;
  createNote: (projectId: ProjectId, name: string) => Promise<NoteArtifact>;
  createProject: (name: string, description: string | null) => Promise<void>;
  discardOutboxItem: (commandId: CommandId) => Promise<void>;
  organizationId: OrganizationId | null;
  outbox: readonly OutboxEnvelope[];
  refresh: () => void;
  retryOutboxItem: (commandId: CommandId) => Promise<void>;
  selectOrganization: (organizationId: OrganizationId) => void;
  signOut: () => Promise<void>;
  snapshot: ProductSnapshot | null;
  view: ProductViewState;
}>;

const ProductCloudContext = createContext<ProductCloudContextValue | null>(null);

const syncStatus = (state: ProductSyncState): "cached" | "live" | "offline" | "synchronizing" =>
  state.status === "error" ? "offline" : state.status;

export const ProductCloudProvider = ({ children }: Readonly<{ children: ReactNode }>) => {
  const [organizationId, setOrganizationId] = useState<OrganizationId | null>(null);
  const [view, setView] = useState<ProductViewState>({ status: "checking-session" });
  const [outbox, setOutbox] = useState<readonly OutboxEnvelope[]>([]);
  const [generation, setGeneration] = useState(0);
  const outboxEngineRef = useRef<ReturnType<typeof createOutboxEngine> | null>(null);
  const productStorageRef = useRef<IndexedDbProductStorage | null>(null);
  const syncEngineRef = useRef<ReturnType<typeof createSyncEngine> | null>(null);

  useEffect(() => {
    let active = true;
    let ownedOutboxEngine: ReturnType<typeof createOutboxEngine> | null = null;
    const cleanups: Array<() => void> = [];
    const transport = createProductCloudTransport(import.meta.env.VITE_GLASS_API_URL);

    const run = async () => {
      try {
        setOutbox([]);
        const session = await transport.session();
        if (!active) return;
        if (session === null) {
          setOutbox([]);
          setView({ status: "signed-out" });
          return;
        }
        const userId = session.userId;
        if (organizationId === null) {
          const activeOrganizationId = loadActiveOrganization(userId);
          if (activeOrganizationId !== null) {
            setOrganizationId(activeOrganizationId);
            return;
          }
          const bootstrap = await loadOrganizationBootstrap(userId);
          if (!active) return;
          if (bootstrap !== null) {
            setOrganizationId(bootstrap.mutation.organizationId);
            return;
          }
          setView({ error: null, status: "organization-selection", userId });
          return;
        }

        const storage = new IndexedDbProductStorage(userId, organizationId);
        productStorageRef.current = storage;
        const cached = await storage.loadSnapshot();
        if (!active) return;
        setView({
          error: null,
          snapshot: cached,
          status: cached === null ? "synchronizing" : "cached",
          userId,
        });
        cleanups.push(
          storage.subscribeSnapshot((snapshot) => {
            if (!active) return;
            setView((current) =>
              "userId" in current && "snapshot" in current
                ? { ...current, error: null, snapshot }
                : current,
            );
          }),
        );

        const outboxEngine = createOutboxEngine({
          classifyTransportError: classifyProductTransportError,
          clock: { now: Date.now },
          onAccepted: () => {
            if (syncEngineRef.current === null) return;
            void syncEngineRef.current.synchronize().catch((error: unknown) => {
              if (!active) return;
              if (error instanceof ProductCloudRequestError && error.status === 401) {
                setOrganizationId(null);
                setView({ status: "signed-out" });
                return;
              }
              setView((current) =>
                "snapshot" in current
                  ? {
                      ...current,
                      error: error instanceof Error ? error.message : "Sync failed.",
                      status: "offline",
                    }
                  : current,
              );
            });
          },
          random: { next: Math.random },
          storage,
          transport,
        });
        outboxEngineRef.current = outboxEngine;
        ownedOutboxEngine = outboxEngine;
        cleanups.push(
          outboxEngine.subscribe((items) => {
            if (!active) return;
            setOutbox(items);
            if (items.some((item) => item.attention?.code === "unauthenticated")) {
              setOrganizationId(null);
              setView({ status: "signed-out" });
            }
          }),
        );
        await outboxEngine.initialize();
        if (!active) return;
        for (const item of outboxEngine.getSnapshot()) {
          if (item.attention?.code === "unauthenticated") {
            // eslint-disable-next-line no-await-in-loop
            await outboxEngine.retry(item.mutation.commandId);
          }
        }

        try {
          let unsubscribeSync: (() => void) | undefined;
          const synchronize = async () => {
            if (!active) return;
            unsubscribeSync?.();
            const syncEngine = createSyncEngine({ organizationId, storage, transport });
            syncEngineRef.current = syncEngine;
            unsubscribeSync = syncEngine.subscribe((state) => {
              if (!active) return;
              setView((current) =>
                "userId" in current && "snapshot" in current
                  ? {
                      ...current,
                      error: state.status === "error" ? state.error.message : null,
                      status: syncStatus(state),
                    }
                  : current,
              );
            });
            await syncEngine.initialize();
            if (!active) return;
            await syncEngine.synchronize();
          };
          cleanups.push(() => unsubscribeSync?.());
          await synchronizeFromCheckpoint({
            drain: outboxEngine.drain,
            hasCachedSnapshot: cached !== null,
            installSnapshot: async () => {
              if (!active) return;
              const fresh = await loadProductSnapshot({ organizationId, transport });
              if (!active) return;
              await storage.saveSnapshot(fresh);
            },
            synchronize,
          });
        } catch (error) {
          if (!active) return;
          if (error instanceof ProductCloudRequestError && error.status === 401) {
            setOrganizationId(null);
            setView({ status: "signed-out" });
            return;
          }
          if (
            error instanceof ProductCloudRequestError &&
            !error.boundary.retryable &&
            error.status < 500
          ) {
            clearActiveOrganization(userId);
            setOrganizationId(null);
            setView({ error: error.message, status: "organization-selection", userId });
            return;
          }
          setView((current) =>
            "userId" in current && "snapshot" in current
              ? {
                  ...current,
                  error: error instanceof Error ? error.message : "Glass Cloud is unavailable.",
                  status: "offline",
                }
              : current,
          );
        }
      } catch (error) {
        if (!active) return;
        setView({
          error: error instanceof Error ? error.message : "Glass Cloud is unavailable.",
          snapshot: null,
          status: "offline",
        });
      }
    };

    void run();
    return () => {
      active = false;
      for (const cleanup of cleanups) cleanup();
      ownedOutboxEngine?.dispose();
      if (outboxEngineRef.current === ownedOutboxEngine) outboxEngineRef.current = null;
      productStorageRef.current = null;
      syncEngineRef.current = null;
    };
  }, [generation, organizationId]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  const settleOutbox = useCallback(async () => {
    const engine = outboxEngineRef.current;
    if (engine === null) return;
    const sync = syncEngineRef.current;
    if (sync === null) await engine.drain();
    else await drainThenSynchronize(engine.drain, sync.synchronize);
  }, []);

  const createNote = useCallback(
    async (projectId: ProjectId, name: string): Promise<NoteArtifact> => {
      if (organizationId === null) throw new Error("Choose an organization first.");
      const outboxEngine = outboxEngineRef.current;
      const syncEngine = syncEngineRef.current;
      const storage = productStorageRef.current;
      if (outboxEngine === null || syncEngine === null || storage === null) {
        throw new Error("Glass Cloud must be live before creating a note.");
      }
      const { mutation, noteId } = createNoteMutation({ name, organizationId, projectId });
      await outboxEngine.enqueue(mutation);
      await drainThenSynchronize(outboxEngine.drain, syncEngine.synchronize);
      if (
        outboxEngine.getSnapshot().some((item) => item.mutation.commandId === mutation.commandId)
      ) {
        throw new Error("The note is queued for Glass Cloud. Reconnect to finish creating it.");
      }
      const latest = await storage.loadSnapshot();
      const note = latest?.artifacts.find(
        (artifact): artifact is NoteArtifact => artifact.kind === "note" && artifact.id === noteId,
      );
      if (note === undefined) throw new Error("The created note is not confirmed yet.");
      return note;
    },
    [organizationId],
  );

  const createProject = useCallback(
    async (name: string, description: string | null): Promise<void> => {
      if (organizationId === null) throw new Error("Choose an organization first.");
      const engine = outboxEngineRef.current;
      const sync = syncEngineRef.current;
      const storage = productStorageRef.current;
      if (engine === null || sync === null || storage === null) {
        throw new Error("Glass Cloud must be live before creating a project.");
      }
      const created = createProjectMutation({ description, name, organizationId });
      await engine.enqueue(created.mutation);
      await drainThenSynchronize(engine.drain, sync.synchronize);
      if (
        engine.getSnapshot().some((item) => item.mutation.commandId === created.mutation.commandId)
      ) {
        throw new Error("The project is queued for Glass Cloud. Reconnect to finish creating it.");
      }
      const latest = await storage.loadSnapshot();
      if (latest?.projects.some((project) => project.id === created.projectId) !== true) {
        throw new Error("The created project is not confirmed yet.");
      }
    },
    [organizationId],
  );

  const retryOutboxItem = useCallback(
    async (commandId: CommandId) => {
      const engine = outboxEngineRef.current;
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
    [settleOutbox],
  );

  const discardOutboxItem = useCallback(
    async (commandId: CommandId) => {
      const engine = outboxEngineRef.current;
      if (engine === null) return;
      const item = engine
        .getSnapshot()
        .find((candidate) => candidate.mutation.commandId === commandId);
      await engine.discard(commandId);
      if (item?.mutation.operation.kind === "organization.create") {
        if ("userId" in view) clearActiveOrganization(view.userId);
        setOrganizationId(null);
        return;
      }
      await settleOutbox();
    },
    [settleOutbox, view],
  );

  const selectOrganization = useCallback(
    (selected: OrganizationId) => {
      if (!("userId" in view)) throw new Error("A Glass Cloud session is required.");
      saveActiveOrganization(view.userId, selected);
      setOutbox([]);
      setView({ status: "checking-session" });
      setOrganizationId(selected);
    },
    [view],
  );

  const bootstrapOrganization = useCallback(
    async (name: string) => {
      if (!("userId" in view)) throw new Error("A Glass Cloud session is required.");
      const created = createOrganizationBootstrapEnvelope(name);
      await saveOrganizationBootstrap(view.userId, created.envelope);
      saveActiveOrganization(view.userId, created.organizationId);
      setOutbox([]);
      setView({ status: "checking-session" });
      setOrganizationId(created.organizationId);
    },
    [view],
  );

  const signOut = useCallback(async () => {
    await signOutSession();
    setOrganizationId(null);
    setOutbox([]);
    setView({ status: "signed-out" });
  }, []);

  const snapshot = "snapshot" in view ? view.snapshot : null;
  const value = useMemo<ProductCloudContextValue>(
    () => ({
      bootstrapOrganization,
      createNote,
      createProject,
      discardOutboxItem,
      organizationId,
      outbox,
      refresh,
      retryOutboxItem,
      selectOrganization,
      signOut,
      snapshot,
      view,
    }),
    [
      bootstrapOrganization,
      createNote,
      createProject,
      discardOutboxItem,
      organizationId,
      outbox,
      refresh,
      retryOutboxItem,
      selectOrganization,
      signOut,
      snapshot,
      view,
    ],
  );

  return <ProductCloudContext.Provider value={value}>{children}</ProductCloudContext.Provider>;
};

export const useProductCloud = (): ProductCloudContextValue => {
  const value = useContext(ProductCloudContext);
  if (value === null) throw new Error("Product cloud context is unavailable.");
  return value;
};
