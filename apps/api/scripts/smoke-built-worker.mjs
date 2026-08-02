import assert from "node:assert/strict";

const workerModule = await import("../dist-worker/index.js");

assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  "The built Worker must expose the default fetch handler.",
);
assert.equal(
  typeof workerModule.handleRequest,
  "function",
  "The built Worker must retain the directly testable request handler.",
);

console.log("Cloudflare Worker bundle smoke check passed.");
