import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDirectory = NodePath.resolve(scriptDirectory, "..");
const mainEntry = NodePath.join(desktopDirectory, "dist-electron", "main.cjs");
const electronCommand = resolveElectronLaunchCommand([mainEntry, "--glass-smoke-test"]);
const childEnvironment = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete childEnvironment.ELECTRON_RUN_AS_NODE;

const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: desktopDirectory,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill();
}, 15_000);

child.on("error", (error) => {
  clearTimeout(timeout);
  throw error;
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);

  const readinessLine = output.split("\n").find((line) => line.includes('"status":"ready"'));
  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const fatalMatches = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (signal !== null || code !== 0 || readinessLine === undefined || fatalMatches.length > 0) {
    process.stderr.write(
      `Desktop runtime smoke test failed (code: ${String(code)}, signal: ${String(signal)}).\n${output}`,
    );
    process.exitCode = 1;
    return;
  }

  const readiness = JSON.parse(readinessLine);
  if (
    readiness.bridgeAvailable !== true ||
    readiness.rendererContentAvailable !== true ||
    readiness.windows !== 1
  ) {
    process.stderr.write(
      `Desktop runtime smoke test returned an invalid state.\n${readinessLine}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Desktop runtime smoke test passed: renderer and preload bridge loaded at ${readiness.rendererUrl}.\n`,
  );
});
