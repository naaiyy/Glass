import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../dist-worker/index.js", import.meta.url), "utf8");

assert.match(
  workerSource,
  /index_default as default/u,
  "The built Worker must export the default fetch handler.",
);
assert.match(workerSource, /handleRequest/u, "The built Worker must retain the request handler.");
assert.match(
  workerSource,
  /GlassConnectAuthority/u,
  "The built Worker must export the Glass Connect authority Durable Object.",
);

console.log("Cloudflare Worker bundle smoke check passed.");
