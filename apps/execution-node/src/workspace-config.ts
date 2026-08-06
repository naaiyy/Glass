import type { WorkspaceId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ExecutionNodeWorkspace } from "./execution-handler.ts";

export type StoredWorkspaceRegistry = Readonly<{
  version: 1;
  workspaces: readonly ExecutionNodeWorkspace[];
}>;

export const defaultWorkspaceRegistryPath = (identityPath: string): string =>
  process.env.GLASS_EXECUTION_WORKSPACES_PATH?.trim() ||
  join(dirname(identityPath), "execution-workspaces.json");

export const decodeWorkspaceRegistrations = (
  input: unknown,
  source: string,
): readonly ExecutionNodeWorkspace[] => {
  if (!Array.isArray(input) || input.length === 0)
    throw new Error(`${source} must register at least one workspace.`);
  const ids = new Set<string>();
  return input.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("id" in candidate) ||
      !("name" in candidate) ||
      !("root" in candidate)
    )
      throw new Error(`Invalid workspace registration at ${source}[${index}].`);
    const id = decodeId<WorkspaceId>(candidate.id, `${source}[${index}].id`);
    if (
      !id.ok ||
      ids.has(String(id.value)) ||
      typeof candidate.name !== "string" ||
      candidate.name.trim().length === 0 ||
      candidate.name.length > 120 ||
      typeof candidate.root !== "string" ||
      !isAbsolute(candidate.root)
    )
      throw new Error(`Invalid workspace registration at ${source}[${index}].`);
    ids.add(String(id.value));
    return { id: id.value, name: candidate.name.trim(), root: resolve(candidate.root) };
  });
};

export const loadWorkspaceRegistry = async (
  path: string,
  options: Readonly<{ allowMissing?: boolean }> = {},
): Promise<readonly ExecutionNodeWorkspace[]> => {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (
      options.allowMissing === true &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !("version" in input) ||
    input.version !== 1 ||
    !("workspaces" in input)
  )
    throw new Error(`Workspace registry ${path} has an unsupported shape or version.`);
  return decodeWorkspaceRegistrations(input.workspaces, `${path}.workspaces`);
};

export const loadConfiguredWorkspaces = async (
  path: string,
  environmentValue = process.env.GLASS_EXECUTION_WORKSPACES,
): Promise<readonly ExecutionNodeWorkspace[]> => {
  if (environmentValue !== undefined) {
    return decodeWorkspaceRegistrations(
      JSON.parse(environmentValue) as unknown,
      "GLASS_EXECUTION_WORKSPACES",
    );
  }
  try {
    return await loadWorkspaceRegistry(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `No execution workspace registry exists at ${path}. Run workspace-add or set GLASS_EXECUTION_WORKSPACES.`,
        { cause: error },
      );
    }
    throw error;
  }
};

export const saveWorkspaceRegistry = async (
  workspaces: readonly ExecutionNodeWorkspace[],
  path: string,
): Promise<void> => {
  const normalized = decodeWorkspaceRegistrations(workspaces, "workspaces");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const registry: StoredWorkspaceRegistry = { version: 1, workspaces: normalized };
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
};

export const addWorkspaceRegistration = async (
  workspace: ExecutionNodeWorkspace,
  path: string,
): Promise<readonly ExecutionNodeWorkspace[]> => {
  const current = await loadWorkspaceRegistry(path, { allowMissing: true });
  const next = [...current.filter((candidate) => candidate.id !== workspace.id), workspace];
  await saveWorkspaceRegistry(next, path);
  return next;
};

export const removeWorkspaceRegistration = async (
  id: WorkspaceId,
  path: string,
): Promise<Readonly<{ removed: boolean; workspaces: readonly ExecutionNodeWorkspace[] }>> => {
  const current = await loadWorkspaceRegistry(path, { allowMissing: true });
  const workspaces = current.filter((candidate) => candidate.id !== id);
  if (workspaces.length === current.length) return { removed: false, workspaces };
  if (workspaces.length === 0) {
    await unlink(path);
    return { removed: true, workspaces };
  }
  await saveWorkspaceRegistry(workspaces, path);
  return { removed: true, workspaces };
};
