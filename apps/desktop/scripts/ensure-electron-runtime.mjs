import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const hostPlatform = NodeOS.platform();
const hostArchitecture = NodeOS.arch();

function getPlatformPath() {
  switch (hostPlatform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are unavailable on ${hostPlatform}.`);
  }
}

function requiredRuntimePaths(electronDirectory, platformPath) {
  const paths = [NodePath.join(electronDirectory, "dist", platformPath)];
  if (hostPlatform === "darwin") {
    paths.push(
      NodePath.join(electronDirectory, "dist", "Electron.app", "Contents", "Info.plist"),
      NodePath.join(
        electronDirectory,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    );
  }
  return paths;
}

function isMachO(filePath) {
  if (hostPlatform !== "darwin") {
    return true;
  }
  const result = NodeChildProcess.spawnSync("file", ["-b", filePath], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("Mach-O");
}

function invalidRuntimePaths(electronDirectory, platformPath) {
  if (hostPlatform !== "darwin") {
    return [];
  }
  return [
    NodePath.join(electronDirectory, "dist", platformPath),
    NodePath.join(
      electronDirectory,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => NodeFS.existsSync(runtimePath) && !isMachO(runtimePath));
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${String(result.status)}.`);
  }
}

function installElectronRuntime(electronDirectory, version) {
  const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "glass-electron-"));
  const archivePath = NodePath.join(
    temporaryDirectory,
    `electron-v${version}-${hostPlatform}-${hostArchitecture}.zip`,
  );

  try {
    runChecked("curl", [
      "-fsSL",
      `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${hostPlatform}-${hostArchitecture}.zip`,
      "-o",
      archivePath,
    ]);
    if (hostPlatform === "darwin") {
      runChecked("ditto", ["-x", "-k", archivePath, NodePath.join(electronDirectory, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        archivePath,
        NodePath.join(electronDirectory, "dist"),
      ]);
    }
  } finally {
    NodeFS.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function ensureElectronRuntime() {
  const packagePath = require.resolve("electron/package.json");
  const packageJson = JSON.parse(NodeFS.readFileSync(packagePath, "utf8"));
  const electronDirectory = NodePath.dirname(packagePath);
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDirectory, "dist", platformPath);
  const requiredPaths = requiredRuntimePaths(electronDirectory, platformPath);
  const needsRepair =
    requiredPaths.some((runtimePath) => !NodeFS.existsSync(runtimePath)) ||
    invalidRuntimePaths(electronDirectory, platformPath).length > 0;

  if (needsRepair) {
    NodeFS.rmSync(NodePath.join(electronDirectory, "dist"), { force: true, recursive: true });
    NodeFS.rmSync(NodePath.join(electronDirectory, "path.txt"), { force: true });
    installElectronRuntime(electronDirectory, packageJson.version);
  }

  const missing = requiredPaths.filter((runtimePath) => !NodeFS.existsSync(runtimePath));
  const invalid = invalidRuntimePaths(electronDirectory, platformPath);
  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(
      `Electron runtime validation failed. Missing: ${missing.join(", ") || "none"}. Invalid: ${invalid.join(", ") || "none"}.`,
    );
  }

  if (hostPlatform !== "win32") {
    NodeFS.chmodSync(electronPath, 0o755);
  }
  NodeFS.writeFileSync(NodePath.join(electronDirectory, "path.txt"), platformPath);
  return electronPath;
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${ensureElectronRuntime()}\n`);
}
