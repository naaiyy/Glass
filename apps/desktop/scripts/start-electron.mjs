import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { desktopDirectory, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;

const mainEntry = NodePath.join(desktopDirectory, "dist-electron", "main.cjs");
const electronCommand = resolveElectronLaunchCommand([mainEntry]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: desktopDirectory,
  env: childEnvironment,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
