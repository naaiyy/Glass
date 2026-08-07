import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";
import type {
  ExecutionEnvironmentId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { environmentCloud } from "./environment-cloud.ts";
import { useEnvironmentDirectory } from "./environment-directory-context.ts";

type FolderOption = Readonly<{
  environmentId: ExecutionEnvironmentId;
  environmentName: string;
  label: string;
  value: string;
  workspaceId: WorkspaceId;
}>;

export const ProjectExecutionSetup = ({
  organizationId,
  projectId,
}: Readonly<{ organizationId: OrganizationId; projectId: ProjectId }>) => {
  const directory = useEnvironmentDirectory();
  const [bindings, setBindings] = useState<readonly WorkspaceBinding[]>([]);
  const [folders, setFolders] = useState<readonly FolderOption[]>([]);
  const [selection, setSelection] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onlineEnvironments = useMemo(
    () =>
      directory.environments.filter(
        (environment) =>
          environment.revokedAt === null && directory.presence[environment.id]?.status === "online",
      ),
    [directory.environments, directory.presence],
  );

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    void Promise.all([
      environmentCloud.bindings(organizationId, projectId),
      Promise.all(
        onlineEnvironments.map(async (environment) => ({
          environment,
          workspaces: await environmentCloud.catalog(organizationId, environment.id),
        })),
      ),
    ])
      .then(([nextBindings, catalogs]) => {
        if (!active) return;
        const nextFolders = catalogs.flatMap(({ environment, workspaces }) =>
          workspaces.map((workspace) => ({
            environmentId: environment.id,
            environmentName: environment.displayName,
            label: `${workspace.name} · ${environment.displayName}`,
            value: `${environment.id}:${workspace.id}`,
            workspaceId: workspace.id,
          })),
        );
        setBindings(nextBindings.filter((binding) => binding.revokedAt === null));
        setFolders(nextFolders);
        setSelection((current) =>
          nextFolders.some((folder) => folder.value === current)
            ? current
            : (nextFolders[0]?.value ?? ""),
        );
      })
      .catch((cause: unknown) =>
        active
          ? setError(cause instanceof Error ? cause.message : "Could not load project folders.")
          : undefined,
      )
      .finally(() => (active ? setBusy(false) : undefined));
    return () => {
      active = false;
    };
  }, [onlineEnvironments, organizationId, projectId]);

  const attach = async () => {
    const folder = folders.find((candidate) => candidate.value === selection);
    if (folder === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const binding = await environmentCloud.bindWorkspace(
        organizationId,
        folder.environmentId,
        projectId,
        folder.workspaceId,
      );
      setBindings((current) => [
        binding,
        ...current.filter(
          (candidate) =>
            candidate.environmentId !== binding.environmentId || candidate.id !== binding.id,
        ),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not use this folder.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Execution</CardTitle>
            <CardDescription>
              Choose where this project can run on a connected computer.
            </CardDescription>
          </div>
          <Badge variant={bindings.length > 0 ? "secondary" : "outline"}>
            {bindings.length > 0
              ? "Ready"
              : onlineEnvironments.length > 0
                ? "Computer online"
                : "Offline"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {bindings.map((binding) => {
          const environment = directory.environments.find(
            (candidate) => candidate.id === binding.environmentId,
          );
          return (
            <div
              className="rounded-lg border border-border px-4 py-3"
              key={`${binding.environmentId}:${binding.id}`}
            >
              <p className="font-medium">{binding.displayName}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {environment?.displayName ?? "Published computer"} ·{" "}
                {directory.presence[binding.environmentId]?.status === "online"
                  ? "Online"
                  : "Offline"}
              </p>
            </div>
          );
        })}
        {onlineEnvironments.length === 0 ? (
          <div>
            <p className="text-sm text-muted-foreground">
              Publish a computer to run commands, use its filesystem, and work with repositories.
            </p>
            <Link
              className={buttonVariants({ className: "mt-4" })}
              to="/workspace/settings/environments"
            >
              Publish a computer
            </Link>
          </div>
        ) : folders.length === 0 && !busy ? (
          <Alert>
            <AlertDescription>
              No folders are available. Start <code>npx glass-connect@latest</code> from the folder
              you want to use, then return here.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="project-folder">Project folder</Label>
              <NativeSelect
                disabled={busy || folders.length === 0}
                id="project-folder"
                onChange={(event) => setSelection(event.target.value)}
                value={selection}
              >
                {folders.map((folder) => (
                  <NativeSelectOption key={folder.value} value={folder.value}>
                    {folder.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button disabled={busy || selection === ""} onClick={() => void attach()} type="button">
              {busy ? "Loading…" : "Use folder"}
            </Button>
          </div>
        )}
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};
