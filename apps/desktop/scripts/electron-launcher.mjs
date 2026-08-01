import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const desktopDirectory = NodePath.resolve(scriptDirectory, "..");
const repositoryRoot = NodePath.resolve(desktopDirectory, "..", "..");
const repositorySuffix = NodePath.basename(repositoryRoot)
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "");
const hostPlatform = NodeOS.platform();
const launcherVersion = 1;

export const APP_DISPLAY_NAME = "Glass (Dev)";
export const APP_BUNDLE_ID = `dev.glass.desktop.${repositorySuffix || "local"}`;

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

function setPlistString(plistPath, key, value) {
  const replace = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    { encoding: "utf8" },
  );
  if (replace.status === 0) {
    return;
  }
  const insert = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plistPath],
    { encoding: "utf8" },
  );
  if (insert.status !== 0) {
    throw new Error(`Failed to set ${key} in ${plistPath}.`);
  }
}

function patchMainBundle(appBundlePath) {
  const plistPath = NodePath.join(appBundlePath, "Contents", "Info.plist");
  setPlistString(plistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(plistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(plistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
}

function patchHelperBundles(appBundlePath) {
  const helperBundles = [
    ["Electron Helper.app", "helper", `${APP_DISPLAY_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${APP_DISPLAY_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${APP_DISPLAY_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${APP_DISPLAY_NAME} Helper (Renderer)`],
  ];

  for (const [bundleName, identifierSuffix, displayName] of helperBundles) {
    const plistPath = NodePath.join(
      appBundlePath,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!NodeFS.existsSync(plistPath)) {
      continue;
    }
    setPlistString(plistPath, "CFBundleDisplayName", displayName);
    setPlistString(plistPath, "CFBundleName", displayName);
    setPlistString(plistPath, "CFBundleIdentifier", `${APP_BUNDLE_ID}.${identifierSuffix}`);
  }
}

export function resolveMacLauncherPaths(appBundlePath) {
  return {
    appBundlePath,
    electronPath: NodePath.join(appBundlePath, "Contents", "MacOS", "Electron"),
  };
}

function buildMacLauncher(electronBinaryPath) {
  const sourceBundlePath = NodePath.resolve(NodePath.dirname(electronBinaryPath), "..", "..");
  const runtimeDirectory = NodePath.join(desktopDirectory, ".electron-runtime");
  const targetBundlePath = NodePath.join(runtimeDirectory, `${APP_DISPLAY_NAME}.app`);
  const metadataPath = NodePath.join(runtimeDirectory, "metadata.json");
  const expectedMetadata = {
    appBundleId: APP_BUNDLE_ID,
    launcherVersion,
    sourceBundlePath,
    sourceMtimeMs: NodeFS.statSync(sourceBundlePath).mtimeMs,
  };
  const currentMetadata = NodeFS.existsSync(metadataPath)
    ? JSON.parse(NodeFS.readFileSync(metadataPath, "utf8"))
    : undefined;

  if (
    !NodeFS.existsSync(targetBundlePath) ||
    JSON.stringify(currentMetadata) !== JSON.stringify(expectedMetadata)
  ) {
    NodeFS.mkdirSync(runtimeDirectory, { recursive: true });
    NodeFS.rmSync(targetBundlePath, { force: true, recursive: true });
    NodeFS.cpSync(sourceBundlePath, targetBundlePath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    patchMainBundle(targetBundlePath);
    patchHelperBundles(targetBundlePath);
    NodeFS.writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  }

  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", targetBundlePath],
  );
  return resolveMacLauncherPaths(targetBundlePath).electronPath;
}

function isLinuxSandboxConfigured(electronBinaryPath) {
  if (hostPlatform !== "linux") {
    return true;
  }
  const sandboxPath = NodePath.join(NodePath.dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const stat = NodeFS.statSync(sandboxPath);
    return stat.uid === 0 && (stat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

function linuxSandboxArguments(electronBinaryPath) {
  return isLinuxSandboxConfigured(electronBinaryPath) ? [] : ["--no-sandbox"];
}

export function resolveElectronBinaryPath({
  ensureRuntime = ensureElectronRuntime,
  createRequire = NodeModule.createRequire,
  moduleUrl = import.meta.url,
} = {}) {
  ensureRuntime();
  return createRequire(moduleUrl)("electron");
}

export function resolveElectronPath() {
  const electronBinaryPath = resolveElectronBinaryPath();
  return hostPlatform === "darwin" ? buildMacLauncher(electronBinaryPath) : electronBinaryPath;
}

export function resolveElectronLaunchCommand(args = []) {
  const electronPath = resolveElectronPath();
  return {
    args: [...linuxSandboxArguments(electronPath), ...args],
    electronPath,
  };
}
