import { initialConnectionState } from "@glass/client-runtime/connections";
import { createOutboxEngine, type OutboxEnvelope } from "@glass/client-runtime/outbox";
import { createSyncEngine, type ProductSyncState } from "@glass/client-runtime/sync";
import { loadProductSnapshot } from "@glass/client-runtime/snapshot";
import type {
  ArtifactId,
  CommandId,
  OrganizationId,
  ProjectId,
  UserId,
} from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { ProductSnapshot } from "@glass/contracts/sync";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";

import { AuthenticationScreen } from "../AuthenticationScreen.tsx";
import { signOut } from "../auth-client.ts";
import { IndexedDbProductStorage } from "./indexed-db.ts";
import { loadOrganizationBootstrap, saveOrganizationBootstrap } from "./indexed-db.ts";
import {
  createNoteMutation,
  createOrganizationBootstrapEnvelope,
  createProjectMutation,
} from "./product-mutations.ts";
import { OrganizationDirectory } from "./OrganizationDirectory.tsx";
import {
  classifyProductTransportError,
  createProductCloudTransport,
  drainThenSynchronize,
  ProductCloudRequestError,
  synchronizeFromCheckpoint,
} from "./transport.ts";

const NoteEditor = lazy(() =>
  import("./NoteEditor.tsx").then((module) => ({ default: module.NoteEditor })),
);

type ProductViewState =
  | Readonly<{ status: "checking-session" }>
  | Readonly<{ status: "signed-out" }>
  | Readonly<{ error: string | null; status: "product-only"; userId: string }>
  | Readonly<{ error: string; snapshot: null; status: "offline" }>
  | Readonly<{
      error: string | null;
      snapshot: ProductSnapshot | null;
      status: "cached" | "live" | "offline" | "synchronizing";
      userId: string;
    }>;

const selectedOrganization = (): OrganizationId | null => {
  const raw = new URLSearchParams(window.location.search).get("organizationId");
  if (raw === null) return null;
  const decoded = decodeId<OrganizationId>(raw, "$organizationId");
  return decoded.ok ? decoded.value : null;
};

const selectedNote = (): ArtifactId | null => {
  const raw = new URLSearchParams(window.location.search).get("noteId");
  if (raw === null) return null;
  const decoded = decodeId<ArtifactId>(raw, "$noteId");
  return decoded.ok ? decoded.value : null;
};

const syncStatus = (state: ProductSyncState): "cached" | "live" | "offline" | "synchronizing" =>
  state.status === "error" ? "offline" : state.status;

const summaryLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const SnapshotSummary = ({
  onCreateNote,
  onCreateProject,
  onOpenNote,
  snapshot,
}: Readonly<{
  onCreateNote: (projectId: ProjectId, name: string) => Promise<void>;
  onCreateProject: (name: string, description: string | null) => Promise<void>;
  onOpenNote: (note: NoteArtifact) => void;
  snapshot: ProductSnapshot;
}>) => {
  const [noteName, setNoteName] = useState("");
  const [noteProjectId, setNoteProjectId] = useState<ProjectId | "">(
    snapshot.projects[0]?.id ?? "",
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  const submitNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = noteName.trim();
    if (noteProjectId === "" || name.length === 0) {
      setCreateError("Choose a project and enter a note name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await onCreateNote(noteProjectId, name);
      setNoteName("");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Glass Cloud could not create the note.",
      );
    } finally {
      setCreating(false);
    }
  };

  const submitProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = projectName.trim();
    if (name.length === 0) {
      setCreateError("Enter a project name.");
      return;
    }
    setCreatingProject(true);
    setCreateError(null);
    try {
      await onCreateProject(name, projectDescription.trim() || null);
      setProjectName("");
      setProjectDescription("");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Glass Cloud could not create the project.",
      );
    } finally {
      setCreatingProject(false);
    }
  };

  return (
    <section className="product-summary" aria-label="Cloud product snapshot">
      <header>
        <div>
          <p className="section-label">Organization</p>
          <h2>{snapshot.organization.name}</h2>
        </div>
        <span className="cursor-chip">cursor {snapshot.cursor}</span>
      </header>

      <div className="summary-counts" aria-label="Product record counts">
        <span>{summaryLabel(snapshot.projects.length, "project")}</span>
        <span>{summaryLabel(snapshot.threads.length, "thread")}</span>
        <span>
          {summaryLabel(
            snapshot.artifacts.filter((artifact) => artifact.kind === "agent-output").length,
            "artifact",
          )}
        </span>
        <span>
          {summaryLabel(
            snapshot.artifacts.filter((artifact) => artifact.kind === "note").length,
            "note",
          )}
        </span>
      </div>

      <div className="entity-columns">
        <section>
          <h3>Projects</h3>
          <form className="note-create-form" onSubmit={(event) => void submitProject(event)}>
            <input
              aria-label="Project name"
              disabled={creatingProject}
              maxLength={240}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="New project name"
              value={projectName}
            />
            <input
              aria-label="Project description"
              disabled={creatingProject}
              maxLength={4000}
              onChange={(event) => setProjectDescription(event.target.value)}
              placeholder="Description (optional)"
              value={projectDescription}
            />
            <button disabled={creatingProject} type="submit">
              {creatingProject ? "Creating…" : "Create project"}
            </button>
          </form>
          {snapshot.projects.length === 0 ? <p className="empty-copy">No projects yet.</p> : null}
          {snapshot.projects.map((project) => (
            <article className="entity-card" key={project.id}>
              <strong>{project.name}</strong>
              <span>{project.description ?? "No description"}</span>
            </article>
          ))}
        </section>
        <section>
          <h3>Threads</h3>
          {snapshot.threads.length === 0 ? <p className="empty-copy">No threads yet.</p> : null}
          {snapshot.threads.map((thread) => (
            <article className="entity-card" key={thread.id}>
              <strong>{thread.title ?? "Untitled thread"}</strong>
              <span>
                {summaryLabel(
                  snapshot.messages.filter((message) => message.threadId === thread.id).length,
                  "message",
                )}
              </span>
            </article>
          ))}
        </section>
        <section>
          <h3>Artifacts</h3>
          {snapshot.artifacts.every((artifact) => artifact.kind !== "agent-output") ? (
            <p className="empty-copy">No artifacts yet.</p>
          ) : null}
          {snapshot.artifacts
            .filter((artifact) => artifact.kind === "agent-output")
            .map((artifact) => (
              <article className="entity-card" key={artifact.id}>
                <strong>{artifact.name}</strong>
                <span>{artifact.kind}</span>
              </article>
            ))}
        </section>
        <section>
          <h3>Notes</h3>
          <form className="note-create-form" onSubmit={(event) => void submitNote(event)}>
            <select
              aria-label="Note project"
              disabled={creating || snapshot.projects.length === 0}
              onChange={(event) => setNoteProjectId(event.target.value as ProjectId)}
              value={noteProjectId}
            >
              {snapshot.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Note name"
              disabled={creating || snapshot.projects.length === 0}
              maxLength={240}
              onChange={(event) => setNoteName(event.target.value)}
              placeholder="New note name"
              value={noteName}
            />
            <button disabled={creating || snapshot.projects.length === 0} type="submit">
              {creating ? "Creating…" : "Create note"}
            </button>
            {createError === null ? null : <p className="field-error">{createError}</p>}
          </form>
          {snapshot.artifacts.every((artifact) => artifact.kind !== "note") ? (
            <p className="empty-copy">No notes yet.</p>
          ) : null}
          {snapshot.artifacts
            .filter((artifact) => artifact.kind === "note")
            .map((note) => (
              <button
                className="entity-card note-card"
                key={note.id}
                onClick={() => onOpenNote(note)}
                type="button"
              >
                <strong>{note.icon === null ? note.name : `${note.icon} ${note.name}`}</strong>
                <span>Open note</span>
              </button>
            ))}
        </section>
      </div>
    </section>
  );
};

export const ProductCore = () => {
  const [organizationId, setOrganizationId] = useState<OrganizationId | null>(selectedOrganization);
  const [organizationInput, setOrganizationInput] = useState(organizationId ?? "");
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [view, setView] = useState<ProductViewState>({ status: "checking-session" });
  const [outbox, setOutbox] = useState<readonly OutboxEnvelope[]>([]);
  const [generation, setGeneration] = useState(0);
  const [selectedNoteId, setSelectedNoteId] = useState<ArtifactId | null>(selectedNote);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const outboxEngineRef = useRef<ReturnType<typeof createOutboxEngine> | null>(null);
  const productStorageRef = useRef<IndexedDbProductStorage | null>(null);
  const syncEngineRef = useRef<ReturnType<typeof createSyncEngine> | null>(null);
  const execution = initialConnectionState().execution;

  useEffect(() => {
    let active = true;
    let ownedOutboxEngine: ReturnType<typeof createOutboxEngine> | null = null;
    const cleanups: Array<() => void> = [];
    const transport = createProductCloudTransport(import.meta.env.VITE_GLASS_API_URL);

    const run = async () => {
      try {
        const session = await transport.session();
        if (!active) return;
        if (session === null) {
          setView({ status: "signed-out" });
          return;
        }
        if (organizationId === null) {
          const bootstrap = await loadOrganizationBootstrap(session.userId);
          if (!active) return;
          if (bootstrap !== null) {
            const recoveredOrganizationId = bootstrap.mutation.organizationId;
            const url = new URL(window.location.href);
            url.searchParams.set("organizationId", recoveredOrganizationId);
            url.searchParams.delete("noteId");
            window.history.replaceState(null, "", url);
            setOrganizationInput(recoveredOrganizationId);
            setOrganizationId(recoveredOrganizationId);
            return;
          }
          setView({ error: null, status: "product-only", userId: session.userId });
          return;
        }

        const storage = new IndexedDbProductStorage(session.userId, organizationId);
        productStorageRef.current = storage;
        const cached = await storage.loadSnapshot();
        if (!active) return;
        setView({
          error: null,
          snapshot: cached,
          status: cached === null ? "synchronizing" : "cached",
          userId: session.userId,
        });
        cleanups.push(
          storage.subscribeSnapshot((snapshot) => {
            if (active) {
              setView((current) =>
                "userId" in current && "snapshot" in current
                  ? { ...current, error: null, snapshot }
                  : current,
              );
            }
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
                setView({ status: "signed-out" });
              } else {
                setView((current) =>
                  "snapshot" in current
                    ? {
                        ...current,
                        error: error instanceof Error ? error.message : "Sync failed.",
                        status: "offline",
                      }
                    : current,
                );
              }
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
              setView({ status: "signed-out" });
              return;
            }
          }),
        );
        await outboxEngine.initialize();
        if (!active) return;
        for (const item of outboxEngine.getSnapshot()) {
          if (item.attention?.code === "unauthenticated") {
            // A fresh authenticated proof was established above, so this is not an unchanged retry.
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
          if (!active) return;
        } catch (error) {
          if (!active) return;
          if (error instanceof ProductCloudRequestError && error.status === 401) {
            setView({ status: "signed-out" });
            return;
          }
          if (
            error instanceof ProductCloudRequestError &&
            !error.boundary.retryable &&
            error.status < 500
          ) {
            setView({ error: error.message, status: "product-only", userId: session.userId });
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

  const chooseOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const decoded = decodeId<OrganizationId>(organizationInput.trim(), "$organizationId");
    if (!decoded.ok) {
      setOrganizationError("Enter a canonical organization UUID.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("organizationId", decoded.value);
    window.location.assign(url);
  };

  const needsAttention = outbox.filter((item) => item.status === "needs-attention");
  const status = view.status;
  const snapshot = "snapshot" in view ? view.snapshot : null;
  const activeNote =
    snapshot?.artifacts.find(
      (artifact): artifact is NoteArtifact =>
        artifact.kind === "note" && artifact.id === selectedNoteId,
    ) ?? null;
  const openNote = (note: NoteArtifact | null) => {
    setSelectedNoteId(note?.id ?? null);
    const url = new URL(window.location.href);
    if (note === null) url.searchParams.delete("noteId");
    else url.searchParams.set("noteId", note.id);
    window.history.replaceState(null, "", url);
  };
  const createNote = async (projectId: ProjectId, name: string): Promise<void> => {
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
    if (outboxEngine.getSnapshot().some((item) => item.mutation.commandId === mutation.commandId)) {
      throw new Error(
        "The note is queued for Glass Cloud. Retry the product connection to finish.",
      );
    }
    const latest = await storage.loadSnapshot();
    const note = latest?.artifacts.find(
      (artifact): artifact is NoteArtifact => artifact.kind === "note" && artifact.id === noteId,
    );
    if (note === undefined)
      throw new Error("The created note is not in the confirmed snapshot yet.");
    openNote(note);
  };
  const createProject = async (name: string, description: string | null): Promise<void> => {
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
      throw new Error("The created project is not in the confirmed snapshot yet.");
    }
  };
  const settleOutbox = async () => {
    const engine = outboxEngineRef.current;
    if (engine === null) return;
    const sync = syncEngineRef.current;
    if (sync === null) await engine.drain();
    else await drainThenSynchronize(engine.drain, sync.synchronize);
  };
  const retryOutboxItem = async (commandId: CommandId) => {
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
  };
  const discardOutboxItem = async (commandId: CommandId) => {
    const engine = outboxEngineRef.current;
    if (engine === null) return;
    const item = engine
      .getSnapshot()
      .find((candidate) => candidate.mutation.commandId === commandId);
    await engine.discard(commandId);
    if (item?.mutation.operation.kind === "organization.create") {
      const url = new URL(window.location.href);
      url.searchParams.delete("organizationId");
      url.searchParams.delete("noteId");
      window.location.assign(url);
      return;
    }
    await settleOutbox();
  };
  const selectOrganization = (selected: OrganizationId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("organizationId", selected);
    url.searchParams.delete("noteId");
    window.location.assign(url);
  };
  const bootstrapOrganization = async (name: string): Promise<void> => {
    const userId = "userId" in view ? (view.userId as UserId) : null;
    if (userId === null) throw new Error("A Glass Cloud session is required.");
    const created = createOrganizationBootstrapEnvelope(name);
    const url = new URL(window.location.href);
    await saveOrganizationBootstrap(userId, created.envelope);
    url.searchParams.set("organizationId", created.organizationId);
    url.searchParams.delete("noteId");
    window.location.assign(url);
  };
  const runOutboxAction = (action: Promise<void>) => {
    void action.catch((error: unknown) => {
      setOrganizationError(
        error instanceof Error ? error.message : "The durable outbox action failed.",
      );
    });
  };

  return (
    <>
      <section className="connection-card" aria-label="Connection boundaries">
        <div>
          <span>Product connection</span>
          <strong>{status}</strong>
          <small>Glass Cloud remains the product authority.</small>
        </div>
        <div>
          <span>Execution connection</span>
          <strong>{execution.status}</strong>
          <small>Optional. Product records remain available without it.</small>
        </div>
      </section>

      {status === "checking-session" ? (
        <p className="state-panel">Checking the Glass Cloud session…</p>
      ) : null}
      {status === "signed-out" ? (
        <AuthenticationScreen onSignedIn={() => setGeneration((value) => value + 1)} />
      ) : null}

      {"userId" in view ? (
        <div className="session-actions">
          <span>Signed in to Glass Cloud</span>
          <button
            onClick={() => {
              setSessionActionError(null);
              void signOut()
                .then(() => setGeneration((value) => value + 1))
                .catch((cause: unknown) =>
                  setSessionActionError(
                    cause instanceof Error ? cause.message : "Glass Cloud sign-out failed.",
                  ),
                );
            }}
            type="button"
          >
            Sign out
          </button>
        </div>
      ) : null}
      {sessionActionError === null ? null : (
        <p className="field-error" role="alert">
          {sessionActionError}
        </p>
      )}

      {status === "product-only" ? (
        <section className="state-panel">
          <h2>Product-only mode</h2>
          <p>
            You are signed in to Glass Cloud. Choose an organization; no execution environment is
            required.
          </p>
        </section>
      ) : null}

      {"userId" in view ? (
        <>
          <OrganizationDirectory
            activeOrganizationId={organizationId}
            onBootstrap={bootstrapOrganization}
            onSelect={selectOrganization}
            userId={view.userId as UserId}
          />
          <details className="advanced-organization-picker">
            <summary>Open an organization by ID</summary>
            <form className="organization-picker" onSubmit={chooseOrganization}>
              <label htmlFor="organization-id">Organization ID</label>
              <div>
                <input
                  id="organization-id"
                  onChange={(event) => setOrganizationInput(event.target.value)}
                  placeholder="00000000-0000-4000-8000-000000000000"
                  spellCheck={false}
                  value={organizationInput}
                />
                <button type="submit">Open</button>
              </div>
              {organizationError === null ? null : (
                <p className="field-error">{organizationError}</p>
              )}
            </form>
          </details>
        </>
      ) : null}

      {"error" in view && view.error !== null ? (
        <section className="offline-banner" role="status">
          <p>{view.error}</p>
          {"snapshot" in view && view.snapshot !== null ? (
            <p>Showing the last validated device cache.</p>
          ) : null}
          {status === "offline" ? (
            <button
              className="retry-button"
              onClick={() => setGeneration((value) => value + 1)}
              type="button"
            >
              Reconnect
            </button>
          ) : null}
        </section>
      ) : null}

      {needsAttention.length > 0 ? (
        <section className="attention-panel" aria-label="Outbox items needing attention">
          <h2>Outbox needs attention</h2>
          {needsAttention.map((item) => (
            <article className="attention-item" key={item.mutation.commandId}>
              <p>
                {item.mutation.operation.kind}: {item.attention?.message}
              </p>
              <div>
                {item.attention?.code === "forbidden" || item.attention?.code === "not-found" ? (
                  <button
                    className="retry-button"
                    onClick={() => runOutboxAction(retryOutboxItem(item.mutation.commandId))}
                    type="button"
                  >
                    Retry after access changes
                  </button>
                ) : null}
                <button
                  className="retry-button"
                  onClick={() => runOutboxAction(discardOutboxItem(item.mutation.commandId))}
                  type="button"
                >
                  Discard command
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {snapshot !== null && activeNote !== null ? (
        <Suspense fallback={<p className="state-panel">Opening editor…</p>}>
          <NoteEditor note={activeNote} onClose={() => openNote(null)} />
        </Suspense>
      ) : null}

      {snapshot !== null && activeNote === null ? (
        <SnapshotSummary
          onCreateNote={createNote}
          onCreateProject={createProject}
          onOpenNote={openNote}
          snapshot={snapshot}
        />
      ) : null}
    </>
  );
};
