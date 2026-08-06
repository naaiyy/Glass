#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "..");
const cloudConfig = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repositoryRoot, "config", "glass-cloud.json"), "utf8"),
);
const defaultIdentityPath = NodePath.join(NodeOS.homedir(), ".glass", "execution-node.json");
const webOrigin = "http://localhost:5173";

export function resolveLaunchConfiguration({ environment, readFile = NodeFS.readFileSync }) {
  const identityPath = environment.GLASS_NODE_IDENTITY_PATH?.trim() || defaultIdentityPath;
  const workspaceConfigPath =
    environment.GLASS_EXECUTION_WORKSPACES_PATH?.trim() ||
    NodePath.join(NodePath.dirname(identityPath), "execution-workspaces.json");
  let identity = null;
  try {
    identity = JSON.parse(readFile(identityPath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const configuredOrigin = environment.GLASS_CLOUD_ORIGIN?.trim();
  const identityOrigin =
    identity !== null && typeof identity.apiOrigin === "string" ? identity.apiOrigin : undefined;
  const cloudOrigin = new URL(configuredOrigin || identityOrigin || cloudConfig.origins.development)
    .origin;
  const productOnly = environment.GLASS_DEV_PRODUCT_ONLY === "1";
  const hasWorkspaceEnvironment = Boolean(environment.GLASS_EXECUTION_WORKSPACES?.trim());
  const hasWorkspaceConfig = NodeFS.existsSync(workspaceConfigPath);
  const executionConfigured =
    !productOnly && identity !== null && (hasWorkspaceEnvironment || hasWorkspaceConfig);

  if (
    executionConfigured &&
    identityOrigin !== undefined &&
    new URL(identityOrigin).origin !== cloudOrigin
  ) {
    throw new Error(
      `GLASS_CLOUD_ORIGIN targets ${cloudOrigin}, but the execution identity belongs to ${new URL(identityOrigin).origin}. Set GLASS_DEV_PRODUCT_ONLY=1 or use a matching identity.`,
    );
  }

  return {
    cloudOrigin,
    executionConfigured,
    hasIdentity: identity !== null,
    hasWorkspaceConfig: hasWorkspaceEnvironment || hasWorkspaceConfig,
    identityPath,
    workspaceConfigPath,
  };
}

function spawn(command, args, options = {}) {
  return NodeChildProcess.spawn(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

function runChecked(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${String(code)}`}.`,
          ),
        );
    });
  });
}

async function waitForHttp(origin, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      // Readiness polling is intentionally sequential so it cannot fan out requests.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(origin, { redirect: "manual" });
      if (response.ok) return;
      lastError = new Error(`${origin} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${origin}.`, { cause: lastError });
}

async function verifyGlassCloud(origin) {
  const response = await fetch(new URL("/health", origin), {
    headers: { accept: "application/json" },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (
    !response.ok ||
    body === null ||
    typeof body !== "object" ||
    body.service !== "glass-api" ||
    body.status !== "ok"
  ) {
    throw new Error(`Glass Cloud at ${origin} did not return a valid health response.`);
  }
}

async function main() {
  const config = resolveLaunchConfiguration({ environment: process.env });
  process.stdout.write(`[glass-dev] Glass Cloud: ${config.cloudOrigin}\n`);
  await verifyGlassCloud(config.cloudOrigin);

  const builds = [runChecked("vp", ["run", "--filter", "@glass/desktop", "build"])];
  if (config.executionConfigured) {
    builds.push(runChecked("vp", ["run", "--filter", "@glass/execution-node", "build"]));
  }
  await Promise.all(builds);

  const children = new Set();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  };
  const failFrom = (label, child) => {
    child.once("error", (error) => {
      if (!stopping) process.stderr.write(`[glass-dev] ${label} failed: ${error.message}\n`);
      process.exitCode = 1;
      stop();
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (stopping) return;
      if (label === "desktop" && (code === 0 || signal === null)) {
        process.exitCode = code ?? 0;
      } else {
        process.stderr.write(
          `[glass-dev] ${label} stopped unexpectedly${signal ? ` (${signal})` : ` (exit ${String(code)})`}.\n`,
        );
        process.exitCode = code === 0 ? 1 : (code ?? 1);
      }
      stop();
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      process.exitCode = 0;
      stop();
    });
  }

  try {
    const web = spawn("vp", ["run", "--filter", "@glass/web", "dev"]);
    children.add(web);
    failFrom("web renderer", web);
    await waitForHttp(webOrigin);

    if (config.executionConfigured) {
      const execution = spawn(
        process.execPath,
        [
          "apps/execution-node/dist/main.js",
          "connect",
          "--identity",
          config.identityPath,
          "--workspaces",
          config.workspaceConfigPath,
        ],
        { env: { ...process.env, GLASS_NODE_IDENTITY_PATH: config.identityPath } },
      );
      children.add(execution);
      failFrom("execution node", execution);
      process.stdout.write(`[glass-dev] Glass Connect: resuming ${config.workspaceConfigPath}\n`);
    } else {
      const reason = !config.hasIdentity
        ? "no published execution identity"
        : !config.hasWorkspaceConfig
          ? `no workspace registry at ${config.workspaceConfigPath}`
          : "GLASS_DEV_PRODUCT_ONLY=1";
      process.stdout.write(`[glass-dev] Product-only mode: ${reason}.\n`);
    }

    const desktop = spawn(process.execPath, ["apps/desktop/scripts/start-electron.mjs"], {
      env: {
        ...process.env,
        GLASS_CLOUD_ORIGIN: config.cloudOrigin,
        GLASS_WEB_DEV_SERVER_URL: webOrigin,
      },
    });
    children.add(desktop);
    failFrom("desktop", desktop);
    process.stdout.write(`[glass-dev] Ready: live renderer + ${config.cloudOrigin}\n`);
  } catch (error) {
    stop();
    throw error;
  }
}

if (NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`[glass-dev] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
