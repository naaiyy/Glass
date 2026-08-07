import type { ArtifactId, ProjectId, ThreadId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import type { NoteArtifact } from "@glass/contracts/product";
import type { ProductSnapshot } from "@glass/contracts/sync";
import { Link, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { AuthenticationScreen } from "../AuthenticationScreen.tsx";
import { useEnvironmentDirectory } from "./environment-directory-context.ts";
import { EnvironmentDirectoryProvider } from "./EnvironmentDirectory.tsx";
import { EnvironmentSettings } from "./EnvironmentSettings.tsx";
import { OrganizationDirectory } from "./OrganizationDirectory.tsx";
import { ProjectExecutionSetup } from "./ProjectExecutionSetup.tsx";
import { useProductCloud } from "./ProductCloudProvider.tsx";
import { resolveWebProductDestination } from "./routing.ts";
import { WorkspaceHeaderContent, WorkspaceHeaderTargetProvider } from "./WorkspaceHeader.tsx";

const NoteEditor = lazy(() =>
  import("./NoteEditor.tsx").then((module) => ({ default: module.NoteEditor })),
);

const summaryLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const CenteredLoadingState = ({ label }: Readonly<{ label: string }>) => (
  <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center gap-2 text-sm text-muted-foreground">
    <Spinner />
    {label}
  </div>
);

const SnapshotSummary = ({
  onCreateProject,
  snapshot,
}: Readonly<{
  onCreateProject: (name: string) => Promise<void>;
  snapshot: ProductSnapshot;
}>) => {
  const [createError, setCreateError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

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
      await onCreateProject(name);
      setProjectName("");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Glass Cloud could not create the project.",
      );
    } finally {
      setCreatingProject(false);
    }
  };

  return (
    <section className="mt-8 flex flex-col gap-4" aria-label="Cloud product snapshot">
      <div>
        <p className="text-xs font-medium text-muted-foreground">Organization</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{snapshot.organization.name}</h1>
      </div>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <form className="flex flex-col gap-2" onSubmit={(event) => void submitProject(event)}>
              <Input
                aria-label="Project name"
                disabled={creatingProject}
                maxLength={240}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="New project name"
                value={projectName}
              />
              <Button disabled={creatingProject} type="submit">
                {creatingProject ? (
                  <>
                    <Spinner />
                    Creating…
                  </>
                ) : (
                  "Create project"
                )}
              </Button>
            </form>
            {snapshot.projects.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No projects yet.</p>
            ) : null}
            {snapshot.projects.map((project) => (
              <Link
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto justify-start px-3 py-2",
                )}
                key={project.id}
                params={{ projectId: project.id }}
                to="/workspace/projects/$projectId"
              >
                <strong className="truncate">{project.name}</strong>
              </Link>
            ))}
            {createError === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

const ErrorState = () => {
  const { refresh, snapshot, view } = useProductCloud();
  if (!("error" in view) || view.error === null) return null;
  return (
    <Alert className="mt-4" variant="destructive" role="status">
      <AlertTitle>Glass Cloud is unavailable</AlertTitle>
      <AlertDescription>
        {view.error}
        {snapshot === null ? null : " Showing the last validated device cache."}
      </AlertDescription>
      {view.status === "offline" ? (
        <Button className="mt-3" onClick={refresh} size="sm" variant="outline" type="button">
          Reconnect
        </Button>
      ) : null}
    </Alert>
  );
};

const OutboxAttention = () => {
  const { discardOutboxItem, outbox, retryOutboxItem } = useProductCloud();
  const [error, setError] = useState<string | null>(null);
  const needsAttention = outbox.filter((item) => item.status === "needs-attention");
  if (needsAttention.length === 0) return null;
  const run = (action: Promise<void>) => {
    setError(null);
    void action.catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "The outbox action failed."),
    );
  };
  return (
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
                onClick={() => run(retryOutboxItem(item.mutation.commandId))}
                type="button"
              >
                Retry after access changes
              </button>
            ) : null}
            <button
              className="retry-button"
              onClick={() => run(discardOutboxItem(item.mutation.commandId))}
              type="button"
            >
              Discard command
            </button>
          </div>
        </article>
      ))}
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};

export const ProductRouteCoordinator = () => {
  const { organizationId, view } = useProductCloud();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const destination = resolveWebProductDestination({
    authenticated: "userId" in view,
    organizationSelected: organizationId !== null,
    pathname,
    status: view.status,
  });

  useEffect(() => {
    if (destination !== null) void navigate({ replace: true, to: destination });
  }, [destination, navigate]);

  return null;
};

export const AuthProductScreen = () => {
  const { refresh, view } = useProductCloud();
  if (view.status === "checking-session") {
    return <CenteredLoadingState label="Checking the Glass Cloud session…" />;
  }
  if (view.status === "signed-out") return <AuthenticationScreen onSignedIn={refresh} />;
  return <ErrorState />;
};

const WorkspaceConnectionStatus = () => {
  const directory = useEnvironmentDirectory();
  const active = directory.environments.filter((environment) => environment.revokedAt === null);
  const online = active.filter(
    (environment) => directory.presence[environment.id]?.status === "online",
  ).length;
  const label =
    active.length === 0 ? "No environments" : online > 0 ? `${online} online` : "Execution offline";
  return (
    <Link
      className={buttonVariants({ className: "min-h-9", variant: "ghost" })}
      to="/workspace/settings/environments"
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          online > 0 ? "bg-emerald-500" : "bg-muted-foreground/60",
        )}
      />
      {label}
    </Link>
  );
};

const WorkspaceLayoutContent = () => {
  const { signOut, view } = useProductCloud();
  const [error, setError] = useState<string | null>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  if (view.status === "checking-session") {
    return <CenteredLoadingState label="Opening your workspace…" />;
  }
  if (!("userId" in view)) return null;
  return (
    <WorkspaceHeaderTargetProvider target={headerTarget}>
      <nav className="sticky top-0 z-50 flex min-h-12 items-center gap-2 bg-background/95 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 flex-1 items-center gap-2" ref={setHeaderTarget} />
        <WorkspaceConnectionStatus />
        <Link
          className={buttonVariants({ className: "min-h-9", variant: "ghost" })}
          to="/workspace/settings/environments"
        >
          Settings
        </Link>
        <Button
          className="shrink-0"
          onClick={() => {
            setError(null);
            void signOut().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : "Glass Cloud sign-out failed."),
            );
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Sign out
        </Button>
      </nav>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <ErrorState />
      <OutboxAttention />
      <Outlet />
    </WorkspaceHeaderTargetProvider>
  );
};

export const WorkspaceProductLayout = () => {
  const { organizationId } = useProductCloud();
  return (
    <EnvironmentDirectoryProvider organizationId={organizationId}>
      <WorkspaceLayoutContent />
    </EnvironmentDirectoryProvider>
  );
};

export const WorkspaceProductScreen = () => {
  const {
    bootstrapOrganization,
    createProject,
    organizationId,
    selectOrganization,
    snapshot,
    view,
  } = useProductCloud();
  const navigate = useNavigate();
  if (!("userId" in view)) return null;
  return (
    <>
      <OrganizationDirectory
        activeOrganizationId={organizationId}
        onBootstrap={bootstrapOrganization}
        onSelect={selectOrganization}
        userId={view.userId}
      />
      {snapshot === null ? null : (
        <SnapshotSummary
          onCreateProject={async (name) => {
            const projectId = await createProject(name);
            await navigate({ params: { projectId }, to: "/workspace/projects/$projectId" });
          }}
          snapshot={snapshot}
        />
      )}
    </>
  );
};

export const EnvironmentSettingsScreen = () => {
  const { organizationId, view } = useProductCloud();
  if (!("userId" in view) || organizationId === null) return null;
  return <EnvironmentSettings organizationId={organizationId} />;
};

const decodeRouteId = <Id extends string>(value: string, path: string): Id | null => {
  const decoded = decodeId<Id>(value, path);
  return decoded.ok ? decoded.value : null;
};

const MissingEntity = ({ label }: Readonly<{ label: string }>) => (
  <Card className="mt-8">
    <CardHeader>
      <CardTitle>{label} unavailable</CardTitle>
      <CardDescription>The requested item is not in the current organization.</CardDescription>
    </CardHeader>
    <CardContent>
      <Link className={buttonVariants({ variant: "outline" })} to="/workspace">
        Back to workspace
      </Link>
    </CardContent>
  </Card>
);

export const NoteProductScreen = () => {
  const { snapshot } = useProductCloud();
  const navigate = useNavigate();
  const { noteId: rawNoteId } = useParams({ from: "/workspace/notes/$noteId" });
  const noteId = decodeRouteId<ArtifactId>(rawNoteId, "$noteId");
  const note = snapshot?.artifacts.find(
    (artifact): artifact is NoteArtifact => artifact.kind === "note" && artifact.id === noteId,
  );
  if (note === undefined) return <MissingEntity label="Note" />;
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Opening editor…
        </div>
      }
    >
      <NoteEditor
        note={note}
        onClose={() =>
          void navigate({
            params: { projectId: note.projectId },
            to: "/workspace/projects/$projectId",
          })
        }
      />
    </Suspense>
  );
};

export const ProjectProductScreen = () => {
  const { createNote, createThread, snapshot } = useProductCloud();
  const navigate = useNavigate();
  const { projectId: rawProjectId } = useParams({ from: "/workspace/projects/$projectId" });
  const projectId = decodeRouteId<ProjectId>(rawProjectId, "$projectId");
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  const [noteName, setNoteName] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [creating, setCreating] = useState<"note" | "thread" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (snapshot === null || project === undefined) return <MissingEntity label="Project" />;
  const threads = snapshot.threads.filter((thread) => thread.projectId === project.id);
  const notes = snapshot.artifacts.filter(
    (artifact): artifact is NoteArtifact =>
      artifact.kind === "note" && artifact.projectId === project.id,
  );
  const artifacts = snapshot.artifacts.filter(
    (artifact) => artifact.kind === "agent-output" && artifact.projectId === project.id,
  );

  const submitNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = noteName.trim();
    if (name.length === 0) {
      setError("Enter a note name.");
      return;
    }
    setCreating("note");
    setError(null);
    try {
      const note = await createNote(project.id, name);
      setNoteName("");
      await navigate({ params: { noteId: note.id }, to: "/workspace/notes/$noteId" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Glass Cloud could not create the note.");
    } finally {
      setCreating(null);
    }
  };

  const submitThread = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating("thread");
    setError(null);
    try {
      const threadId = await createThread(project.id, threadTitle.trim() || null);
      setThreadTitle("");
      await navigate({ params: { threadId }, to: "/workspace/threads/$threadId" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Glass Cloud could not create the thread.");
    } finally {
      setCreating(null);
    }
  };

  return (
    <>
      <WorkspaceHeaderContent>
        <Link className={buttonVariants({ variant: "ghost", size: "sm" })} to="/workspace">
          Back to projects
        </Link>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <h1 className="truncate text-sm font-semibold">{project.name}</h1>
      </WorkspaceHeaderContent>
      <section className="mt-6 flex flex-col gap-4" aria-label={`Project: ${project.name}`}>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ProjectExecutionSetup organizationId={project.organizationId} projectId={project.id} />
        <Card>
          <CardHeader>
            <CardTitle>Threads</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <form className="flex gap-2" onSubmit={(event) => void submitThread(event)}>
              <Input
                aria-label="Thread title"
                disabled={creating !== null}
                maxLength={240}
                onChange={(event) => setThreadTitle(event.target.value)}
                placeholder="Thread title (optional)"
                value={threadTitle}
              />
              <Button disabled={creating !== null} type="submit">
                {creating === "thread" ? "Creating…" : "New thread"}
              </Button>
            </form>
            {threads.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No threads yet.</p>
            ) : null}
            {threads.map((thread) => (
              <Link
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto justify-start px-3 py-2",
                )}
                key={thread.id}
                params={{ threadId: thread.id }}
                to="/workspace/threads/$threadId"
              >
                <span className="flex flex-col gap-0.5 text-left">
                  <strong>{thread.title ?? "Untitled thread"}</strong>
                  <span className="font-normal text-muted-foreground">
                    {summaryLabel(
                      snapshot.messages.filter((message) => message.threadId === thread.id).length,
                      "message",
                    )}
                  </span>
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <form className="flex gap-2" onSubmit={(event) => void submitNote(event)}>
              <Input
                aria-label="Note name"
                disabled={creating !== null}
                maxLength={240}
                onChange={(event) => setNoteName(event.target.value)}
                placeholder="New note name"
                value={noteName}
              />
              <Button disabled={creating !== null} type="submit">
                {creating === "note" ? "Creating…" : "New note"}
              </Button>
            </form>
            {notes.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No notes yet.</p>
            ) : null}
            {notes.map((note) => (
              <Link
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto justify-start px-3 py-2",
                )}
                key={note.id}
                params={{ noteId: note.id }}
                to="/workspace/notes/$noteId"
              >
                <strong>{note.icon === null ? note.name : `${note.icon} ${note.name}`}</strong>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Artifacts</CardTitle>
            <CardDescription>Agent work in this project produces artifacts here.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {artifacts.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No artifacts yet.</p>
            ) : null}
            {artifacts.map((artifact) => (
              <Link
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto justify-start px-3 py-2",
                )}
                key={artifact.id}
                params={{ artifactId: artifact.id }}
                to="/workspace/artifacts/$artifactId"
              >
                <strong>{artifact.name}</strong>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  );
};

export const ThreadProductScreen = () => {
  const { createMessage, snapshot } = useProductCloud();
  const { threadId: rawThreadId } = useParams({ from: "/workspace/threads/$threadId" });
  const threadId = decodeRouteId<ThreadId>(rawThreadId, "$threadId");
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (snapshot === null || thread === undefined) return <MissingEntity label="Thread" />;
  const messages = snapshot.messages.filter((message) => message.threadId === thread.id);
  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = body.trim();
    if (message.length === 0) {
      setError("Enter a message.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await createMessage(thread.projectId, thread.id, message);
      setBody("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Glass Cloud could not send the message.");
    } finally {
      setSending(false);
    }
  };
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>{thread.title ?? "Untitled thread"}</CardTitle>
        <CardDescription>{summaryLabel(messages.length, "message")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Link
          className={buttonVariants({ variant: "outline", size: "sm" })}
          params={{ projectId: thread.projectId }}
          to="/workspace/projects/$projectId"
        >
          Back to project
        </Link>
        {messages.map((message) => (
          <article className="rounded-lg border p-3" key={message.id}>
            <p className="whitespace-pre-wrap text-sm">{message.body}</p>
          </article>
        ))}
        <form className="flex gap-2" onSubmit={(event) => void submitMessage(event)}>
          <Input
            aria-label="Message"
            disabled={sending}
            maxLength={1_000_000}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write a message"
            value={body}
          />
          <Button disabled={sending} type="submit">
            {sending ? "Sending…" : "Send"}
          </Button>
        </form>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export const ArtifactProductScreen = () => {
  const { snapshot } = useProductCloud();
  const { artifactId: rawArtifactId } = useParams({ from: "/workspace/artifacts/$artifactId" });
  const artifactId = decodeRouteId<ArtifactId>(rawArtifactId, "$artifactId");
  const artifact = snapshot?.artifacts.find(
    (candidate) => candidate.kind === "agent-output" && candidate.id === artifactId,
  );
  if (artifact === undefined) return <MissingEntity label="Artifact" />;
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>{artifact.name}</CardTitle>
        <CardDescription>{artifact.kind}</CardDescription>
      </CardHeader>
    </Card>
  );
};
