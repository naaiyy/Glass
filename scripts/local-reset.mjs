#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";

import {
  repositoryLocalRoot,
  repositoryPath,
  resolveDockerArguments,
  resolveLocalRuntime,
} from "./local-runtime.mjs";

const runtime = resolveLocalRuntime(process.env);
const composeEnvironment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: `glass-${runtime.instance}`,
  GLASS_LOCAL_POSTGRES_DATABASE: runtime.databaseName,
  GLASS_LOCAL_POSTGRES_PASSWORD: "glass_local",
  GLASS_LOCAL_POSTGRES_PORT: String(runtime.ports.postgres),
};
const child = NodeChildProcess.spawn(
  "docker",
  [
    ...resolveDockerArguments(),
    "compose",
    "--file",
    "infra/local/compose.yaml",
    "down",
    "--volumes",
    "--remove-orphans",
  ],
  { cwd: repositoryPath, env: composeEnvironment, stdio: "inherit" },
);
const result = await new Promise((complete, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => complete({ code, signal }));
});
if (result.code !== 0 || result.signal !== null)
  throw new Error("Could not remove the local Glass database.");

if (!runtime.stateRoot.startsWith(`${repositoryLocalRoot}/`))
  throw new Error("Refusing to remove local state outside the repository local root.");
await NodeFS.rm(runtime.stateRoot, { recursive: true, force: true });
process.stdout.write(`Removed local Glass state for ${runtime.instance}.\n`);
