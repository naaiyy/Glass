import cloud from "../../../config/glass-cloud.json" with { type: "json" };
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const productionStateRoot = join(homedir(), ".glass", "production");
process.env.GLASS_CLOUD_ORIGIN ??= cloud.origins.production;
process.env.GLASS_NODE_IDENTITY_PATH ??= join(productionStateRoot, "execution-node.json");
process.env.GLASS_EXECUTION_WORKSPACES_PATH ??= join(
  productionStateRoot,
  "execution-workspaces.json",
);

if (platform() !== "win32") {
  const require = createRequire(import.meta.url);
  const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
  await Promise.all(
    [
      join(nodePtyRoot, "prebuilds", `${platform()}-${arch()}`, "spawn-helper"),
      join(nodePtyRoot, "build", "Release", "spawn-helper"),
    ].map(async (helper) => {
      try {
        await chmod(helper, 0o755);
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      }
    }),
  );
}

await import("../src/main.ts");
