import type { WorkspaceBinding } from "@glass/contracts/execution-cloud";
import type {
  ExecutionEnvironmentId,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from "@glass/contracts/ids";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import {
  bindWorkspace,
  listWorkspaceBindings,
  loadWorkspaceCatalog,
} from "../cloud/environments.ts";
import { errorMessage } from "../lib/errors.ts";
import { ActionButton, SelectMenu, StateCard } from "../ui/primitives.tsx";
import { useEnvironmentDirectory } from "./EnvironmentDirectoryProvider.tsx";

type FolderOption = Readonly<{
  environmentId: ExecutionEnvironmentId;
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
  const [selection, setSelection] = useState<string | null>(null);
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
      listWorkspaceBindings(directory.apiBaseUrl, organizationId, projectId),
      Promise.all(
        onlineEnvironments.map(async (environment) => ({
          environment,
          workspaces: await loadWorkspaceCatalog(
            directory.apiBaseUrl,
            organizationId,
            environment.id,
          ),
        })),
      ),
    ])
      .then(([nextBindings, catalogs]) => {
        if (!active) return;
        const nextFolders = catalogs.flatMap(({ environment, workspaces }) =>
          workspaces.map((workspace) => ({
            environmentId: environment.id,
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
            : (nextFolders[0]?.value ?? null),
        );
      })
      .catch((cause: unknown) => (active ? setError(errorMessage(cause)) : undefined))
      .finally(() => (active ? setBusy(false) : undefined));
    return () => {
      active = false;
    };
  }, [directory.apiBaseUrl, onlineEnvironments, organizationId, projectId]);

  return (
    <StateCard title="Execution">
      <Text className="text-sm leading-5 text-muted-foreground">
        Choose where this project can run on a connected computer.
      </Text>
      {bindings.map((binding) => {
        const environment = directory.environments.find(
          (candidate) => candidate.id === binding.environmentId,
        );
        return (
          <View
            className="mt-2 rounded-lg border border-border px-3 py-3"
            key={`${binding.environmentId}:${binding.id}`}
          >
            <Text className="font-semibold text-foreground">{binding.displayName}</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              {environment?.displayName ?? "Published computer"} ·{" "}
              {directory.presence[binding.environmentId]?.status === "online"
                ? "Online"
                : "Offline"}
            </Text>
          </View>
        );
      })}
      {onlineEnvironments.length === 0 ? (
        <Text className="mt-2 text-sm text-muted-foreground">
          Publish a computer in Settings to use its filesystem, repositories, and commands.
        </Text>
      ) : folders.length === 0 && !busy ? (
        <Text className="mt-2 text-sm text-muted-foreground">
          No folders are available. Start npx glass-connect@latest from the folder you want to use.
        </Text>
      ) : (
        <>
          <SelectMenu
            disabled={busy || folders.length === 0}
            label="Project folder"
            onSelect={setSelection}
            options={folders}
            placeholder="Choose a folder"
            value={selection}
          />
          <ActionButton
            disabled={busy || selection === null}
            label={busy ? "Loading…" : "Use folder"}
            onPress={() => {
              const folder = folders.find((candidate) => candidate.value === selection);
              if (folder === undefined) return;
              setBusy(true);
              setError(null);
              void bindWorkspace(
                directory.apiBaseUrl,
                organizationId,
                folder.environmentId,
                projectId,
                folder.workspaceId,
              )
                .then((binding) =>
                  setBindings((current) => [
                    binding,
                    ...current.filter(
                      (candidate) =>
                        candidate.environmentId !== binding.environmentId ||
                        candidate.id !== binding.id,
                    ),
                  ]),
                )
                .catch((cause: unknown) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            }}
          />
        </>
      )}
      {error === null ? null : <Text className="text-sm text-destructive">{error}</Text>}
    </StateCard>
  );
};
