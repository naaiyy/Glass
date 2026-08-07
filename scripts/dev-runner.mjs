#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { prepareLocalRuntime, resolveLocalRuntime } from "./local-runtime.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "..");
const defaultIdentityRoot = NodePath.join(NodeOS.homedir(), ".glass", "local");
const defaultWebPort = 5173;
const defaultMetroPort = 8081;
const maximumPort = 65_535;
const portScanRange = 100;
const surfaces = new Set(["api", "web", "desktop", "mobile", "mobile-ios"]);

export function parseDevelopmentSurface(input) {
  const surface = input?.trim() || "web";
  if (!surfaces.has(surface)) {
    throw new Error(
      `Unknown Glass development surface "${surface}". Expected api, web, desktop, mobile, or mobile-ios.`,
    );
  }
  return surface;
}

function parsePort(input, fallback, variable) {
  if (input === undefined || input.trim() === "") return fallback;
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > maximumPort) {
    throw new Error(`${variable} must be an integer from 1 to ${maximumPort}.`);
  }
  return port;
}

export const parseWebPort = (input) => parsePort(input, defaultWebPort, "GLASS_DEV_WEB_PORT");

export const parseMetroPort = (input) => parsePort(input, defaultMetroPort, "GLASS_DEV_METRO_PORT");

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
  runtime = resolveLocalRuntime(environment),
}) {
  const identityPath =
    environment.GLASS_NODE_IDENTITY_PATH?.trim() ||
    NodePath.join(defaultIdentityRoot, runtime.instance, "execution-node.json");
  const workspaceConfigPath =
    environment.GLASS_EXECUTION_WORKSPACES_PATH?.trim() ||
    NodePath.join(NodePath.dirname(identityPath), "execution-workspaces.json");
  let identity = null;
  try {
    identity = JSON.parse(readFile(identityPath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  // Local development never silently targets a deployment because an unrelated published identity
  // happens to exist on the machine. An override is explicit; otherwise the local API wins.
  const configuredOrigin = environment.GLASS_CLOUD_ORIGIN?.trim();
  const cloudOrigin = resolveCloudOrigin(configuredOrigin || runtime.apiOrigin);
  const identityOrigin =
    identity !== null && typeof identity.apiOrigin === "string"
      ? resolveCloudOrigin(identity.apiOrigin)
      : undefined;
  const hasPublishedIdentity =
    identity !== null &&
    typeof identity === "object" &&
    typeof identity.environment === "object" &&
    identity.environment !== null;
  const identityMatchesCloud = identityOrigin === cloudOrigin;
  const executionConfigured = hasPublishedIdentity && identityMatchesCloud;

  return {
    cloudOrigin,
    executionConfigured,
    hasIdentity: identity !== null,
    hasPublishedIdentity,
    identityMatchesCloud,
    identityOrigin,
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
    server.listen({ port }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(start) {
  const end = Math.min(maximumPort, start + portScanRange);
  for (let port = start; port <= end; port += 1) {
    // Port selection is deliberately sequential so parallel worktrees cannot fan out listeners.
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  throw new Error(`No development port is available from ${start} to ${end}.`);
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
  const runtime = resolveLocalRuntime(process.env);
  const config = resolveLaunchConfiguration({ environment: process.env, runtime });
  process.stdout.write(`[glass-dev] Surface: ${surface}\n`);
  process.stdout.write(`[glass-dev] Local Glass Cloud: ${config.cloudOrigin}\n`);

  const children = new Set();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  };
  const watch = (label, child, { isolated = false, primary = false, transient = false } = {}) => {
    children.add(child);
    child.once("error", (error) => {
      if (!stopping) process.stderr.write(`[glass-dev] ${label} failed: ${error.message}\n`);
      if (isolated) return;
      process.exitCode = 1;
      stop();
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (stopping) return;
      if (isolated) {
        process.stdout.write(`[glass-dev] ${label} unavailable; product development continues.\n`);
        return;
      }
      if (transient && code === 0 && signal === null) {
        process.stdout.write(`[glass-dev] ${label} launched.\n`);
        return;
      }
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
    const prepared = await prepareLocalRuntime(runtime);
    const api = spawn(
      "apps/api/node_modules/.bin/wrangler",
      [
        "dev",
        "--config",
        prepared.wranglerConfigPath,
        "--env-file",
        prepared.devVarsPath,
        "--ip",
        "127.0.0.1",
        "--port",
        String(runtime.ports.api),
        "--persist-to",
        NodePath.join(runtime.stateRoot, "wrangler"),
        "--show-interactive-dev-session=false",
      ],
      { env: { ...process.env, NO_COLOR: "1" } },
    );
    watch("local Glass Cloud", api, { primary: surface === "api" });
    await waitForHttp(`${config.cloudOrigin}/health`);
    await verifyGlassCloud(config.cloudOrigin);
    process.stdout.write(`[glass-dev] Local database: ${runtime.databaseName}\n`);

    if (surface === "api") {
      process.stdout.write(`[glass-dev] Ready: ${config.cloudOrigin}\n`);
      return;
    }

    const builds = [];
    if (surface === "desktop") {
      builds.push(runChecked("vp", ["run", "--filter", "@glass/desktop", "build"]));
    }
    if (config.executionConfigured) {
      builds.push(runChecked("vp", ["run", "--filter", "@glass/execution-node", "build"]));
    }
    await Promise.all(builds);

    if (config.executionConfigured) {
      const execution = spawn(process.execPath, ["apps/execution-node/dist/main.js", "connect"], {
        env: {
          ...process.env,
          GLASS_NODE_IDENTITY_PATH: config.identityPath,
          GLASS_EXECUTION_WORKSPACES_PATH: config.workspaceConfigPath,
        },
      });
      watch("execution node", execution, { isolated: true });
      process.stdout.write(`[glass-dev] Glass Connect: ${config.workspaceConfigPath}\n`);
    } else {
      const reason = !config.hasPublishedIdentity
        ? "run `vp run glass-connect` to publish this computer"
        : `the configured identity belongs to ${config.identityOrigin}; use another identity path or publish for ${config.cloudOrigin}`;
      process.stdout.write(`[glass-dev] Glass Connect unavailable: ${reason}.\n`);
    }

    if (surface === "mobile" || surface === "mobile-ios") {
      const metroPort = await findAvailablePort(runtime.ports.metro);
      const metro = spawn(
        "vp",
        ["run", "--filter", "@glass/mobile", "start:metro", "--port", String(metroPort)],
        {
          env: {
            ...process.env,
            EXPO_PUBLIC_GLASS_API_URL: config.cloudOrigin,
          },
        },
      );
      watch("Metro", metro, { primary: true });
      await waitForHttp(`http://127.0.0.1:${metroPort}/status`);

      if (surface === "mobile-ios") {
        const ios = spawn(
          "vp",
          ["run", "--filter", "@glass/mobile", "start:ios", "--port", String(metroPort)],
          {
            env: {
              ...process.env,
              EXPO_PUBLIC_GLASS_API_URL: config.cloudOrigin,
            },
          },
        );
        watch("iOS app", ios, { transient: true });
      }

      process.stdout.write(
        `[glass-dev] Ready: ${surface} + Metro ${metroPort} + ${config.cloudOrigin}\n`,
      );
      return;
    }

    const port = await findAvailablePort(runtime.ports.web);
    const webOrigin = `http://127.0.0.1:${port}`;
    const web = spawn("vp", ["run", "--filter", "@glass/web", "start:vite"], {
      env: webEnvironment(
        config.cloudOrigin,
        port,
        surface === "web" && process.env.GLASS_DEV_OPEN_BROWSER !== "0",
      ),
    });
    watch("web renderer", web, { primary: surface === "web" });
    await waitForHttp(webOrigin);

    if (surface === "desktop") {
      const desktop = spawn(process.execPath, ["apps/desktop/scripts/start-electron.mjs"], {
        env: {
          ...process.env,
          GLASS_CLOUD_ORIGIN: config.cloudOrigin,
          GLASS_WEB_DEV_SERVER_URL: webOrigin,
        },
      });
      watch("desktop", desktop, { primary: true });
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
