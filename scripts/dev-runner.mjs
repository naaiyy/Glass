#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "..");
const cloudConfig = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repositoryRoot, "config", "glass-cloud.json"), "utf8"),
);
const defaultIdentityPath = NodePath.join(
  NodeOS.homedir(),
  ".glass",
  "development",
  "execution-node.json",
);
const defaultWebPort = 5173;
const maximumPort = 65_535;
const portScanRange = 100;
const surfaces = new Set(["web", "desktop", "mobile", "mobile-ios"]);

export function parseDevelopmentSurface(input) {
  const surface = input?.trim() || "web";
  if (!surfaces.has(surface)) {
    throw new Error(
      `Unknown Glass development surface "${surface}". Expected web, desktop, mobile, or mobile-ios.`,
    );
  }
  return surface;
}

export function parseWebPort(input) {
  if (input === undefined || input.trim() === "") return defaultWebPort;
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > maximumPort) {
    throw new Error(`GLASS_DEV_WEB_PORT must be an integer from 1 to ${maximumPort}.`);
  }
  return port;
}

export function resolveCloudOrigin(input) {
  const url = new URL(input);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Glass Cloud must be an HTTPS origin or a loopback development origin.");
  }
  return url.origin;
}

export function resolveLaunchConfiguration({
  environment,
  readFile = NodeFS.readFileSync,
  fileExists = NodeFS.existsSync,
}) {
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

  // Development never silently targets staging or production because an unrelated published
  // identity happens to exist on the machine. An override is explicit; otherwise shared dev wins.
  const configuredOrigin = environment.GLASS_CLOUD_ORIGIN?.trim();
  const cloudOrigin = resolveCloudOrigin(configuredOrigin || cloudConfig.origins.development);
  const identityOrigin =
    identity !== null && typeof identity.apiOrigin === "string"
      ? resolveCloudOrigin(identity.apiOrigin)
      : undefined;
  const hasWorkspaceEnvironment = Boolean(environment.GLASS_EXECUTION_WORKSPACES?.trim());
  const hasWorkspaceConfig = fileExists(workspaceConfigPath);
  const identityMatchesCloud = identityOrigin === cloudOrigin;
  const executionConfigured =
    identity !== null && identityMatchesCloud && (hasWorkspaceEnvironment || hasWorkspaceConfig);

  return {
    cloudOrigin,
    executionConfigured,
    hasIdentity: identity !== null,
    identityMatchesCloud,
    identityOrigin,
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

function canListen(port) {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailableWebPort(start = defaultWebPort) {
  const end = Math.min(maximumPort, start + portScanRange);
  for (let port = start; port <= end; port += 1) {
    // Port selection is deliberately sequential so parallel worktrees cannot fan out listeners.
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  throw new Error(`No Glass web development port is available from ${start} to ${end}.`);
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
  const healthResponse = await fetch(new URL("/health", origin), {
    headers: { accept: "application/json" },
  });
  const contentType = healthResponse.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await healthResponse.json() : null;
  if (
    !healthResponse.ok ||
    body === null ||
    typeof body !== "object" ||
    body.service !== "glass-api" ||
    body.status !== "ok"
  ) {
    throw new Error(`Glass Cloud at ${origin} did not return a valid health response.`);
  }

  const authResponse = await fetch(new URL("/api/auth/get-session", origin), {
    headers: { accept: "application/json" },
  });
  if (!authResponse.ok || !(authResponse.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(`Glass Cloud authentication at ${origin} is unavailable.`);
  }
}

const webEnvironment = (cloudOrigin, port, openBrowser) => ({
  ...process.env,
  GLASS_CLOUD_ORIGIN: cloudOrigin,
  GLASS_DEV_OPEN_BROWSER: openBrowser ? "1" : "0",
  GLASS_DEV_WEB_PORT: String(port),
});

async function main() {
  const surface = parseDevelopmentSurface(process.argv[2]);
  const config = resolveLaunchConfiguration({ environment: process.env });
  process.stdout.write(`[glass-dev] Surface: ${surface}\n`);
  process.stdout.write(`[glass-dev] Glass Cloud: ${config.cloudOrigin}\n`);
  await verifyGlassCloud(config.cloudOrigin);

  const builds = [];
  if (surface === "desktop") {
    builds.push(runChecked("vp", ["run", "--filter", "@glass/desktop", "build"]));
  }
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
  const watch = (label, child, primary = false) => {
    children.add(child);
    child.once("error", (error) => {
      if (!stopping) process.stderr.write(`[glass-dev] ${label} failed: ${error.message}\n`);
      process.exitCode = 1;
      stop();
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (stopping) return;
      if (!primary || code !== 0 || signal !== null) {
        process.stderr.write(
          `[glass-dev] ${label} stopped unexpectedly${signal ? ` (${signal})` : ` (exit ${String(code)})`}.\n`,
        );
        process.exitCode = code === 0 ? 1 : (code ?? 1);
      } else {
        process.exitCode = 0;
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
      watch("execution node", execution);
      process.stdout.write(`[glass-dev] Glass Connect: ${config.workspaceConfigPath}\n`);
    } else {
      const reason = !config.hasIdentity
        ? "publish this machine to enable execution"
        : !config.identityMatchesCloud
          ? `the configured identity belongs to ${config.identityOrigin}; publish one for ${config.cloudOrigin}`
          : `register a workspace at ${config.workspaceConfigPath}`;
      process.stdout.write(`[glass-dev] Glass Connect unavailable: ${reason}.\n`);
    }

    if (surface === "mobile" || surface === "mobile-ios") {
      const task = surface === "mobile-ios" ? "start:ios" : "start:metro";
      const mobile = spawn("vp", ["run", "--filter", "@glass/mobile", task], {
        env: { ...process.env, EXPO_PUBLIC_GLASS_API_URL: config.cloudOrigin },
      });
      watch(surface, mobile, true);
      process.stdout.write(`[glass-dev] Ready: ${surface} + ${config.cloudOrigin}\n`);
      return;
    }

    const port = await findAvailableWebPort(parseWebPort(process.env.GLASS_DEV_WEB_PORT));
    const webOrigin = `http://127.0.0.1:${port}`;
    const web = spawn("vp", ["run", "--filter", "@glass/web", "start:vite"], {
      env: webEnvironment(
        config.cloudOrigin,
        port,
        surface === "web" && process.env.GLASS_DEV_OPEN_BROWSER !== "0",
      ),
    });
    watch("web renderer", web, surface === "web");
    await waitForHttp(webOrigin);

    if (surface === "desktop") {
      const desktop = spawn(process.execPath, ["apps/desktop/scripts/start-electron.mjs"], {
        env: {
          ...process.env,
          GLASS_CLOUD_ORIGIN: config.cloudOrigin,
          GLASS_WEB_DEV_SERVER_URL: webOrigin,
        },
      });
      watch("desktop", desktop, true);
    }

    process.stdout.write(
      `[glass-dev] Ready: ${surface === "web" ? webOrigin : `desktop + ${webOrigin}`} + ${config.cloudOrigin}\n`,
    );
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
