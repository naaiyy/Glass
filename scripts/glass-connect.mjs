#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveLocalRuntime } from "./local-runtime.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repositoryRoot = NodePath.resolve(scriptDirectory, "..");
const runtime = resolveLocalRuntime(process.env);
const stateRoot = NodePath.join(NodeOS.homedir(), ".glass", "local", runtime.instance);
const identityPath =
  process.env.GLASS_NODE_IDENTITY_PATH?.trim() || NodePath.join(stateRoot, "execution-node.json");
const workspaceRegistryPath =
  process.env.GLASS_EXECUTION_WORKSPACES_PATH?.trim() ||
  NodePath.join(stateRoot, "execution-workspaces.json");
const rawArguments = process.argv.slice(2);
const launcherArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const helpRequested = launcherArguments.includes("--help") || launcherArguments.includes("-h");

process.env.GLASS_CLOUD_ORIGIN ??= runtime.apiOrigin;
process.env.GLASS_NODE_IDENTITY_PATH ??= identityPath;
process.env.GLASS_EXECUTION_WORKSPACES_PATH ??= workspaceRegistryPath;

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} stopped${signal === null ? ` with exit code ${String(code)}` : ` with ${signal}`}.`,
          ),
        );
    });
  });

await run("vp", ["run", "--filter", "@glass/execution-node", "build"]);
if (!helpRequested && !NodeFS.existsSync(workspaceRegistryPath)) {
  await run(process.execPath, [
    "apps/execution-node/dist/main.js",
    "workspace-add",
    "--id",
    randomUUID(),
    "--name",
    NodePath.basename(repositoryRoot),
    "--root",
    repositoryRoot,
  ]);
}
await run(process.execPath, ["apps/execution-node/dist/main.js", ...launcherArguments]);
