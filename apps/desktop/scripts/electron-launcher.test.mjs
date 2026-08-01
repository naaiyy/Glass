import { assert, describe, it } from "vite-plus/test";
import { resolveElectronBinaryPath, resolveMacLauncherPaths } from "./electron-launcher.mjs";

describe("electron launcher", () => {
  it("validates the runtime before resolving Electron", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      ensureRuntime: () => calls.push("ensure"),
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the conventional Electron executable inside the registered bundle", () => {
    const paths = resolveMacLauncherPaths("/repo/apps/desktop/.electron-runtime/Glass (Dev).app");
    assert.equal(
      paths.electronPath,
      "/repo/apps/desktop/.electron-runtime/Glass (Dev).app/Contents/MacOS/Electron",
    );
  });
});
