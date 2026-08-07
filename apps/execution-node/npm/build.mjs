import { chmod } from "node:fs/promises";

import { build } from "esbuild";

await build({
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __glassCreateRequire } from "node:module"; const require = __glassCreateRequire(import.meta.url);',
  },
  bundle: true,
  entryPoints: ["npm/cli.ts"],
  external: ["node-pty"],
  format: "esm",
  outfile: "npm/dist/cli.js",
  platform: "node",
  target: "node24",
});
await chmod("npm/dist/cli.js", 0o755);
