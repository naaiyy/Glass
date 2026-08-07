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
import { Label } from "~/components/ui/label";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { AuthenticationScreen } from "../AuthenticationScreen.tsx";
import { EnvironmentPanel } from "./EnvironmentPanel.tsx";
import { OrganizationDirectory } from "./OrganizationDirectory.tsx";
import { useProductCloud } from "./ProductCloudProvider.tsx";
import { resolveWebProductDestination } from "./routing.ts";

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
  onCreateNote,
  onCreateProject,
  snapshot,
}: Readonly<{
  onCreateNote: (projectId: ProjectId, name: string) => Promise<void>;
  onCreateProject: (name: string, description: string | null) => Promise<void>;
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
  const visibleNotes = snapshot.artifacts.filter(
    (artifact): artifact is NoteArtifact =>
      artifact.kind === "note" && artifact.projectId === noteProjectId,
  );

  useEffect(() => {
    if (!snapshot.projects.some((project) => project.id === noteProjectId)) {
      setNoteProjectId(snapshot.projects[0]?.id ?? "");
    }
  }, [noteProjectId, snapshot.projects]);

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
              <Input
                aria-label="Project description"
                disabled={creatingProject}
                maxLength={4000}
                onChange={(event) => setProjectDescription(event.target.value)}
                placeholder="Description (optional)"
                value={projectDescription}
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
                <span className="flex min-w-0 flex-col gap-0.5 text-left">
                  <strong className="truncate">{project.name}</strong>
                  <span className="truncate font-normal text-muted-foreground">
                    {project.description ?? "No description"}
                  </span>
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Threads</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snapshot.threads.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No threads yet.</p>
            ) : null}
            {snapshot.threads.map((thread) => (
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
            <CardTitle>Artifacts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {snapshot.artifacts.every((artifact) => artifact.kind !== "agent-output") ? (
              <p className="py-3 text-sm text-muted-foreground">No artifacts yet.</p>
            ) : null}
            {snapshot.artifacts
              .filter((artifact) => artifact.kind === "agent-output")
              .map((artifact) => (
                <Link
                  className={cn(
                    buttonVariants({ variant: "ghost" }),
                    "h-auto justify-start px-3 py-2",
                  )}
                  key={artifact.id}
                  params={{ artifactId: artifact.id }}
                  to="/workspace/artifacts/$artifactId"
                >
                  <span className="flex flex-col gap-0.5 text-left">
                    <strong>{artifact.name}</strong>
                    <span className="font-normal text-muted-foreground">{artifact.kind}</span>
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
            <form className="flex flex-col gap-2" onSubmit={(event) => void submitNote(event)}>
              <Label htmlFor="note-project">Project</Label>
              <NativeSelect
                disabled={creating || snapshot.projects.length === 0}
                id="note-project"
                onChange={(event) => setNoteProjectId(event.target.value as ProjectId)}
                value={noteProjectId}
              >
                {snapshot.projects.map((project) => (
                  <NativeSelectOption key={project.id} value={project.id}>
                    {project.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Input
                aria-label="Note name"
                disabled={creating || snapshot.projects.length === 0}
                maxLength={240}
                onChange={(event) => setNoteName(event.target.value)}
                placeholder="New note name"
                value={noteName}
              />
              <Button disabled={creating || snapshot.projects.length === 0} type="submit">
                {creating ? (
                  <>
                    <Spinner />
                    Creating…
                  </>
                ) : (
                  "Create note"
                )}
              </Button>
              {createError === null ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              )}
            </form>
            {visibleNotes.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No notes yet.</p>
            ) : null}
            {visibleNotes.map((note) => (
              <Link
                className={cn(
                  buttonVariants({ variant: "ghost" }),
                  "h-auto justify-start px-3 py-2",
                )}
                key={note.id}
                params={{ noteId: note.id }}
                to="/workspace/notes/$noteId"
              >
                <span className="flex flex-col gap-0.5 text-left">
                  <strong>{note.icon === null ? note.name : `${note.icon} ${note.name}`}</strong>
                  <span className="font-normal text-muted-foreground">Open note</span>
                </span>
              </Link>
            ))}
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

export const WorkspaceProductLayout = () => {
  const { signOut, view } = useProductCloud();
  const [error, setError] = useState<string | null>(null);
  if (view.status === "checking-session") {
    return <CenteredLoadingState label="Opening your workspace…" />;
  }
  if (!("userId" in view)) return null;
  return (
    <>
      <nav className="flex items-center justify-end gap-2 py-3">
        <Button
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
    </>
  );
};

export const WorkspaceProductScreen = () => {
  const {
    bootstrapOrganization,
    createNote,
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
      {organizationId === null ? null : (
        <EnvironmentPanel organizationId={organizationId} projects={snapshot?.projects ?? []} />
      )}
      {snapshot === null ? null : (
        <SnapshotSummary
          onCreateNote={async (projectId, name) => {
            const note = await createNote(projectId, name);
            await navigate({ params: { noteId: note.id }, to: "/workspace/notes/$noteId" });
          }}
          onCreateProject={createProject}
          snapshot={snapshot}
        />
      )}
    </>
  );
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
      <NoteEditor note={note} onClose={() => void navigate({ to: "/workspace" })} />
    </Suspense>
  );
};

export const ProjectProductScreen = () => {
  const { snapshot } = useProductCloud();
  const { projectId: rawProjectId } = useParams({ from: "/workspace/projects/$projectId" });
  const projectId = decodeRouteId<ProjectId>(rawProjectId, "$projectId");
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) return <MissingEntity label="Project" />;
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        <CardDescription>{project.description ?? "No description"}</CardDescription>
      </CardHeader>
    </Card>
  );
};

export const ThreadProductScreen = () => {
  const { snapshot } = useProductCloud();
  const { threadId: rawThreadId } = useParams({ from: "/workspace/threads/$threadId" });
  const threadId = decodeRouteId<ThreadId>(rawThreadId, "$threadId");
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return <MissingEntity label="Thread" />;
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>{thread.title ?? "Untitled thread"}</CardTitle>
        <CardDescription>
          {summaryLabel(
            snapshot?.messages.filter((message) => message.threadId === thread.id).length ?? 0,
            "message",
          )}
        </CardDescription>
      </CardHeader>
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
