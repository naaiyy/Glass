import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import cloud from "../config/glass-cloud.json" with { type: "json" };

import { applyLocalMigrations } from "./local-database.mjs";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const localRoot = NodePath.join(repositoryRoot, ".glass-local");
const basePorts = { api: 8787, metro: 8081, postgres: 55_432, web: 5173 };
const portOffsetRange = 1_000;
const postgresPassword = "glass_local";

export const resolveDockerArguments = (environment = process.env) => {
  const configured = environment.GLASS_DOCKER_CONTEXT?.trim();
  if (configured) return ["--context", configured];
  const active = NodeChildProcess.spawnSync("docker", ["context", "show"], {
    encoding: "utf8",
  }).stdout?.trim();
  if (active !== "socktainer") return [];
  const desktop = NodeChildProcess.spawnSync(
    "docker",
    ["--context", "desktop-linux", "version", "--format", "{{.Server.Version}}"],
    { encoding: "utf8" },
  );
  return desktop.status === 0 ? ["--context", "desktop-linux"] : [];
};

const run = (command, args, options = {}) =>
  new Promise((complete, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) complete();
      else
        reject(
          new Error(
            `${command} stopped${signal === null ? ` with exit code ${String(code)}` : ` with ${signal}`}.`,
          ),
        );
    });
  });

const stableHash = (input) => {
  let hash = 2_166_136_261;
  for (const character of input) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
};

const isMainCheckout = () => {
  try {
    return NodeFS.statSync(NodePath.join(repositoryRoot, ".git")).isDirectory();
  } catch {
    return false;
  }
};

export const resolveLocalRuntime = (environment = process.env) => {
  const configuredInstance = environment.GLASS_DEV_INSTANCE?.trim();
  const instance =
    configuredInstance || (isMainCheckout() ? "main" : NodePath.basename(repositoryRoot));
  const offset =
    configuredInstance || !isMainCheckout() ? stableHash(instance) % portOffsetRange : 0;
  const ports = {
    api: Number(environment.GLASS_DEV_API_PORT ?? basePorts.api + offset),
    metro: Number(environment.GLASS_DEV_METRO_PORT ?? basePorts.metro + offset),
    postgres: Number(environment.GLASS_DEV_POSTGRES_PORT ?? basePorts.postgres + offset),
    web: Number(environment.GLASS_DEV_WEB_PORT ?? basePorts.web + offset),
  };
  for (const [name, value] of Object.entries(ports)) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535)
      throw new Error(`Local ${name} port is invalid: ${String(value)}.`);
  }
  const safeInstance = instance
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/gu, "-")
    .slice(0, 40);
  const databaseName = `glass_${safeInstance.replaceAll("-", "_")}`;
  const stateRoot = NodePath.join(localRoot, safeInstance);
  const databaseUrl = `postgres://glass:${postgresPassword}@127.0.0.1:${String(ports.postgres)}/${databaseName}`;
  return {
    apiOrigin: `http://127.0.0.1:${String(ports.api)}`,
    databaseName,
    databaseUrl,
    instance: safeInstance,
    ports,
    stateRoot,
    webOrigin: `http://127.0.0.1:${String(ports.web)}`,
  };
};

const writeWranglerConfig = async (runtime) => {
  const configPath = NodePath.join(runtime.stateRoot, "wrangler.json");
  const config = {
    name: `glass-api-local-${runtime.instance}`,
    main: NodePath.join(repositoryRoot, "apps/api/src/index.ts"),
    compatibility_date: "2026-08-01",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      ALCHEMY_STAGE: "local",
      CONNECT_TUNNEL_ZONE_NAME: "glassapp.dev",
    },
    durable_objects: {
      bindings: [{ name: "CONNECT_AUTHORITY", class_name: "GlassConnectAuthority" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["GlassConnectAuthority"] }],
    hyperdrive: [
      {
        binding: "HYPERDRIVE",
        id: "00000000000000000000000000000000",
        localConnectionString: runtime.databaseUrl,
      },
    ],
    services: [
      {
        binding: "TUNNEL_CONTROL",
        service: cloud.services.stagingTunnelControl,
        remote: true,
      },
    ],
    ratelimits: [
      {
        name: "CONNECT_NODE_RATE_LIMIT",
        namespace_id: "1",
        simple: { limit: 10_000, period: 60 },
      },
      {
        name: "TRUST_MUTATION_RATE_LIMIT",
        namespace_id: "2",
        simple: { limit: 20, period: 60 },
      },
      {
        name: "TRUST_POLL_RATE_LIMIT",
        namespace_id: "3",
        simple: { limit: 120, period: 60 },
      },
    ],
    secrets: {
      required: [
        "BETTER_AUTH_SECRET",
        "CONNECT_TICKET_SECRET",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
      ],
    },
  };
  await NodeFS.promises.mkdir(runtime.stateRoot, { recursive: true });
  await NodeFS.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return configPath;
};

export const prepareLocalRuntime = async (runtime) => {
  const devVarsPath = NodePath.join(repositoryRoot, "apps/api/.dev.vars");
  if (!NodeFS.existsSync(devVarsPath))
    throw new Error("Local authentication is not configured. Run `vp run dev:setup` first.");
  const composeEnvironment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: `glass-${runtime.instance}`,
    GLASS_LOCAL_POSTGRES_DATABASE: runtime.databaseName,
    GLASS_LOCAL_POSTGRES_PASSWORD: postgresPassword,
    GLASS_LOCAL_POSTGRES_PORT: String(runtime.ports.postgres),
  };
  const dockerArguments = resolveDockerArguments();
  await run(
    "docker",
    [
      ...dockerArguments,
      "compose",
      "--file",
      "infra/local/compose.yaml",
      "up",
      "--detach",
      "--wait",
      "postgres",
    ],
    { env: composeEnvironment },
  );
  await applyLocalMigrations(runtime.databaseUrl);
  const wranglerConfigPath = await writeWranglerConfig(runtime);
  return { devVarsPath, wranglerConfigPath };
};

export const generateLocalSecrets = () => ({
  BETTER_AUTH_SECRET: NodeCrypto.randomBytes(32).toString("base64url"),
  CONNECT_TICKET_SECRET: NodeCrypto.randomBytes(32).toString("base64url"),
});

export const repositoryLocalRoot = localRoot;
export const repositoryPath = repositoryRoot;

if (NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = resolveLocalRuntime();
  await prepareLocalRuntime(runtime);
  process.stdout.write(`${JSON.stringify(runtime, null, 2)}\n`);
}
