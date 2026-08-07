#!/usr/bin/env node

import type { WorkspaceId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import { readExecutionDescriptor } from "@glass/execution-core/capabilities";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { cwd } from "node:process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { CloudflaredSupervisor } from "./cloudflared.ts";
import { createExecutionNodeHandler, type ExecutionNodeWorkspace } from "./execution-handler.ts";
import {
  beginPairing,
  createNodeIdentity,
  defaultIdentityPath,
  EnvironmentRequestError,
  finishPairing,
  loadNodeIdentity,
  refreshCredential,
  saveNodeIdentity,
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
const command =
  args[0] === "--help" || args[0] === "-h"
    ? "help"
    : args[0] === undefined || args[0].startsWith("--")
      ? "start"
      : args[0];
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const identityPath = defaultIdentityPath();
const workspaceRegistryPath = defaultWorkspaceRegistryPath(identityPath);

const publishIdentity = async (origin: string) => {
  let identity = createNodeIdentity(origin);
  const nodePlatform =
    platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : "linux";
  const pairing = await beginPairing(identity, option("--name") ?? hostname(), nodePlatform);
  await saveNodeIdentity(identity, identityPath);
  process.stdout.write(
    `Publish this computer with Glass Connect.\nOne-time code: ${pairing.pairingCode}\nOpen Glass: ${new URL(pairing.approvalPath, identity.apiOrigin)}\nWaiting for approval…\n`,
  );
  identity = await finishPairing(identity, pairing);
  identity = await refreshCredential(identity);
  await saveNodeIdentity(identity, identityPath);
  process.stdout.write(`Published as ${identity.environment?.displayName}. Connecting…\n`);
  return identity;
};

const runConnectCommand = async (): Promise<void> => {
  const commandArguments = [...process.execArgv, process.argv[1] ?? "", "connect"];
  const child = spawn(process.execPath, commandArguments, { stdio: "inherit" });
  const result = await new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((complete, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => complete({ code, signal }));
  });
  if (result.signal !== null) process.kill(process.pid, result.signal);
  if (result.code !== 0) process.exitCode = result.code ?? 1;
};

if (command === "start") {
  const configuredOrigin = process.env.GLASS_CLOUD_ORIGIN;
  let identity = await loadNodeIdentity(identityPath);
  if (
    identity !== null &&
    configuredOrigin !== undefined &&
    new URL(identity.apiOrigin).origin !== new URL(configuredOrigin).origin
  ) {
    throw new Error(
      `This Glass Connect identity belongs to ${identity.apiOrigin}. Use stage-specific Glass Connect state for ${configuredOrigin}.`,
    );
  }
  if (identity !== null && identity.environment !== null) {
    try {
      identity = await refreshCredential(identity);
      await saveNodeIdentity(identity, identityPath);
      process.stdout.write(`Resuming Glass Connect as ${identity.environment?.displayName}.\n`);
    } catch (error) {
      if (!(error instanceof EnvironmentRequestError) || ![401, 403, 404].includes(error.status))
        throw error;
      process.stdout.write("The previous publication is no longer valid. Publishing again.\n");
      identity = await publishIdentity(identity.apiOrigin);
    }
  } else {
    const origin = configuredOrigin ?? identity?.apiOrigin;
    if (origin === undefined)
      throw new Error("Glass Connect has no configured Glass Cloud origin.");
    identity = await publishIdentity(origin);
  }
  const registeredWorkspaces = await loadWorkspaceRegistry(workspaceRegistryPath, {
    allowMissing: true,
  });
  const root = cwd();
  if (!registeredWorkspaces.some((workspace) => workspace.root === root)) {
    const workspaceId = decodeId<WorkspaceId>(randomUUID(), "workspace.id");
    if (!workspaceId.ok) throw new Error("Could not create a workspace identifier.");
    await addWorkspaceRegistration(
      { id: workspaceId.value, name: basename(root), root },
      workspaceRegistryPath,
    );
    process.stdout.write(`Added ${root} to the folders available in Glass.\n`);
  }
  await runConnectCommand();
} else if (command === "help") {
  process.stdout.write("Usage: glass-connect [--name NAME]\n");
} else if (command === "descriptor") {
  process.stdout.write(`${JSON.stringify(await Effect.runPromise(readExecutionDescriptor))}\n`);
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
    throw new Error("No published computer exists. Start Glass Connect without a subcommand.");
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
  const controlFailure = (error: unknown): boolean => {
    if (
      (error instanceof TunnelControlError || error instanceof EnvironmentRequestError) &&
      (error.status === 401 || error.status === 403 || error.status === 404)
    ) {
      void shutdown();
      return true;
    }
    return false;
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
      if (controlFailure(error)) {
        process.stderr.write(
          "[Glass Connect] This computer is no longer published. Start Glass Connect again to publish it with a new code.\n",
        );
        return;
      }
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
} else {
  throw new Error(
    "Usage: glass-connect [--name NAME] | descriptor | workspace-add --id UUID --name NAME --root PATH | workspace-list | workspace-remove --id UUID",
  );
}
