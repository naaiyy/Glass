import type { WorkspaceId } from "@glass/contracts/ids";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addWorkspaceRegistration,
  loadConfiguredWorkspaces,
  loadWorkspaceRegistry,
  removeWorkspaceRegistration,
} from "./workspace-config.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111" as WorkspaceId;
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222" as WorkspaceId;
const roots: string[] = [];

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "glass-workspaces-"));
  roots.push(root);
  return { root, registry: join(root, "execution-workspaces.json") };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("execution workspace registry", () => {
  it("persists an owner-only versioned registry and loads it", async () => {
    const { registry, root } = await setup();
    await addWorkspaceRegistration({ id: workspaceId, name: "Glass", root }, registry);
    await expect(loadWorkspaceRegistry(registry)).resolves.toEqual([
      { id: workspaceId, name: "Glass", root },
    ]);
    expect(JSON.parse(await readFile(registry, "utf8"))).toMatchObject({ version: 1 });
    expect((await stat(registry)).mode & 0o777).toBe(0o600);
  });

  it("keeps the environment variable as an explicit compatibility override", async () => {
    const { registry, root } = await setup();
    await addWorkspaceRegistration({ id: workspaceId, name: "Stored", root }, registry);
    await expect(
      loadConfiguredWorkspaces(
        registry,
        JSON.stringify([{ id: otherWorkspaceId, name: "Override", root }]),
      ),
    ).resolves.toEqual([{ id: otherWorkspaceId, name: "Override", root }]);
  });

  it("updates a registration by stable workspace ID", async () => {
    const { registry, root } = await setup();
    await addWorkspaceRegistration({ id: workspaceId, name: "Before", root }, registry);
    await addWorkspaceRegistration({ id: workspaceId, name: "After", root }, registry);
    await expect(loadWorkspaceRegistry(registry)).resolves.toEqual([
      { id: workspaceId, name: "After", root },
    ]);
  });

  it("removes the registry when the final workspace is removed", async () => {
    const { registry, root } = await setup();
    await addWorkspaceRegistration({ id: workspaceId, name: "Glass", root }, registry);
    await expect(removeWorkspaceRegistration(workspaceId, registry)).resolves.toEqual({
      removed: true,
      workspaces: [],
    });
    await expect(loadWorkspaceRegistry(registry, { allowMissing: true })).resolves.toEqual([]);
  });
});
