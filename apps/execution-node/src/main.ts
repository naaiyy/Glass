import type { WorkspaceId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import { readExecutionDescriptor } from "@glass/execution-core/capabilities";
import { Effect } from "effect";
import { hostname, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CloudflaredSupervisor } from "./cloudflared.ts";
import { createExecutionNodeHandler, type ExecutionNodeWorkspace } from "./execution-handler.ts";
import {
  beginPairing,
  beginKeyRotation,
  createNodeIdentity,
  defaultIdentityPath,
  finishPairing,
  finishKeyRotation,
  loadNodeIdentity,
  refreshCredential,
  saveNodeIdentity,
  stageKeyRotation,
} from "./identity.ts";
import { createTunnelControl, TunnelControlError } from "./tunnel-control.ts";
import { startTunnelOrigin } from "./tunnel-origin.ts";
import { FrameDeliveryJournal, FrameDeliveryRecovery } from "./frame-delivery-journal.ts";
import {
  addWorkspaceRegistration,
  defaultWorkspaceRegistryPath,
  loadConfiguredWorkspaces,
  loadWorkspaceRegistry,
  removeWorkspaceRegistration,
} from "./workspace-config.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "descriptor";
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const identityPath = option("--identity") ?? defaultIdentityPath();
const workspaceRegistryPath = option("--workspaces") ?? defaultWorkspaceRegistryPath(identityPath);

if (command === "descriptor") {
  process.stdout.write(`${JSON.stringify(await Effect.runPromise(readExecutionDescriptor))}\n`);
} else if (command === "pair") {
  const origin = option("--api") ?? process.env.GLASS_CLOUD_ORIGIN;
  if (origin === undefined) throw new Error("Set GLASS_CLOUD_ORIGIN or pass --api.");
  let identity = (await loadNodeIdentity(identityPath)) ?? createNodeIdentity(origin);
  const nodePlatform =
    platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";
  const pairing = await beginPairing(identity, option("--name") ?? hostname(), nodePlatform);
  await saveNodeIdentity(identity, identityPath);
  process.stdout.write(
    `Publish this execution environment in Glass.\nPairing code: ${pairing.pairingCode}\nApproval: ${new URL(pairing.approvalPath, identity.apiOrigin)}\n`,
  );
  identity = await finishPairing(identity, pairing);
  identity = await refreshCredential(identity);
  await saveNodeIdentity(identity, identityPath);
  process.stdout.write(`Published as ${identity.environment?.displayName}.\n`);
} else if (command === "workspace-add") {
  const id = decodeId<WorkspaceId>(option("--id"), "workspace.id");
  const name = option("--name")?.trim();
  const root = option("--root")?.trim();
  if (!id.ok || name === undefined || name.length === 0 || root === undefined || !isAbsolute(root))
    throw new Error("workspace-add requires --id UUID, --name NAME, and --root ABSOLUTE_PATH.");
  const workspaces = await addWorkspaceRegistration(
    { id: id.value, name, root: resolve(root) },
    workspaceRegistryPath,
  );
  process.stdout.write(
    `Registered ${name} in ${workspaceRegistryPath} (${workspaces.length} total).\n`,
  );
} else if (command === "workspace-list") {
  const workspaces = await loadWorkspaceRegistry(workspaceRegistryPath, { allowMissing: true });
  process.stdout.write(`${JSON.stringify({ path: workspaceRegistryPath, workspaces }, null, 2)}\n`);
} else if (command === "workspace-remove") {
  const id = decodeId<WorkspaceId>(option("--id"), "workspace.id");
  if (!id.ok) throw new Error("workspace-remove requires --id UUID.");
  const result = await removeWorkspaceRegistration(id.value, workspaceRegistryPath);
  process.stdout.write(
    `${result.removed ? "Removed" : "Did not find"} workspace ${id.value} in ${workspaceRegistryPath}.\n`,
  );
} else if (command === "connect") {
  let identity = await loadNodeIdentity(identityPath);
  if (identity === null)
    throw new Error("No execution identity exists. Run the pair command first.");
  const workspaces: readonly ExecutionNodeWorkspace[] =
    await loadConfiguredWorkspaces(workspaceRegistryPath);
  const descriptor = await Effect.runPromise(readExecutionDescriptor);
  const handleDispatch = await createExecutionNodeHandler({
    checkpointRoot:
      process.env.GLASS_EXECUTION_STATE_ROOT ?? join(dirname(identityPath), "execution-state"),
    workspaces,
  });
  const hello = {
    type: "node.hello" as const,
    protocolVersion: 1 as const,
    capabilities: descriptor.capabilities,
    workspaces: workspaces.map(({ id, name }) => ({ id, name })),
  };
  const control = createTunnelControl({
    load: async () => {
      const loaded = await loadNodeIdentity(identityPath);
      if (loaded === null) throw new Error("Execution identity disappeared.");
      identity = loaded;
      return loaded;
    },
    save: async (next) => {
      identity = next;
      await saveNodeIdentity(next, identityPath);
    },
  });
  let tunnelHostname = "";
  const deliveryJournal = new FrameDeliveryJournal(
    join(dirname(identityPath), "frame-delivery"),
    (sessionId, frame) => control.recordFrame(sessionId, frame),
  );
  const deliveryRecovery = new FrameDeliveryRecovery(deliveryJournal);
  await deliveryRecovery.flush(true);
  const origin = await startTunnelOrigin({
    control,
    getAuthority: async () => {
      const current = (await loadNodeIdentity(identityPath)) ?? identity;
      if (current === null) throw new Error("Execution identity disappeared.");
      return { hostname: tunnelHostname, identity: current };
    },
    handleDispatch,
    journal: deliveryJournal,
  });
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let supervisor!: CloudflaredSupervisor;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    if (recoveryTimer !== null) clearInterval(recoveryTimer);
    recoveryTimer = null;
    try {
      await control.publishPresence(hello, "offline");
    } catch {
      // Revocation and network loss must not prevent local shutdown.
    }
    await supervisor.stop();
    await origin.stop();
  };
  const controlFailure = (error: unknown): void => {
    if (error instanceof TunnelControlError && (error.status === 401 || error.status === 403))
      void shutdown();
  };
  supervisor = new CloudflaredSupervisor({
    getConfiguration: async () => {
      const configuration = await control.configure(origin.localOrigin);
      tunnelHostname = configuration.hostname;
      return configuration;
    },
    installRoot: join(dirname(identityPath), "bin"),
    log: ({ stream, value }) => {
      process.stderr.write(`[Glass Connect ${stream}] ${value}\n`);
    },
    onFatal: controlFailure,
    onHealthy: () => {
      void control
        .publishPresence(hello, "online")
        .then(() => deliveryRecovery.flush(true))
        .catch(controlFailure);
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        void control
          .publishPresence(hello, "online")
          .then(() => deliveryRecovery.flush(true))
          .catch(controlFailure);
      }, 30_000);
      if (recoveryTimer !== null) clearInterval(recoveryTimer);
      recoveryTimer = setInterval(() => {
        void deliveryRecovery.flush().catch(controlFailure);
      }, 1_000);
    },
    onDisconnected: (error) => {
      process.stderr.write(
        `[Glass Connect] Connector unavailable: ${error instanceof Error ? error.message : "Unknown failure."}\n`,
      );
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      if (recoveryTimer !== null) clearInterval(recoveryTimer);
      recoveryTimer = null;
      void control.publishPresence(hello, "offline").catch(controlFailure);
    },
  });
  supervisor.start();
  for (const signalName of ["SIGINT", "SIGTERM"] as const)
    process.once(signalName, () => {
      void shutdown().finally(() => {
        process.exitCode = 0;
      });
    });
} else if (command === "rotate") {
  let identity = await loadNodeIdentity(identityPath);
  if (identity === null || identity.environment === null)
    throw new Error("No published execution identity exists. Run the pair command first.");
  identity = await refreshCredential(identity);
  identity = stageKeyRotation(identity);
  // The staged replacement is durable before Cloud can commit it, so a lost response cannot lose the key.
  await saveNodeIdentity(identity, identityPath);
  identity = await beginKeyRotation(identity);
  await saveNodeIdentity(identity, identityPath);
  const rotation = identity.pendingRotation?.rotation;
  if (rotation === null || rotation === undefined)
    throw new Error("Rotation setup did not complete.");
  process.stdout.write(
    `Approve this key rotation in Glass.\nRotation code: ${rotation.rotationCode}\nApproval: ${new URL(rotation.approvalPath, identity.apiOrigin)}\n`,
  );
  identity = await finishKeyRotation(identity);
  // Promote the replacement immediately after confirmed Cloud success, before credential refresh.
  await saveNodeIdentity(identity, identityPath);
  identity = await refreshCredential(identity);
  await saveNodeIdentity(identity, identityPath);
  process.stdout.write(`Rotated key for ${identity.environment?.displayName}.\n`);
} else {
  throw new Error(
    "Usage: glass-execution-node descriptor | pair [--api URL] [--name NAME] | rotate | workspace-add --id UUID --name NAME --root PATH | workspace-list | workspace-remove --id UUID | connect",
  );
}
