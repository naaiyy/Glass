import { assert, describe, it } from "vite-plus/test";

import { resolveLaunchConfiguration } from "./dev-runner.mjs";

const missing = () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  throw error;
};

describe("Glass development launcher", () => {
  it("uses the deployed development cloud when no identity exists", () => {
    const config = resolveLaunchConfiguration({ environment: {}, readFile: missing });
    assert.equal(
      config.cloudOrigin,
      "https://glasscloud-api-dev-iqwgnfdineqiceki.naaiyyyy.workers.dev",
    );
    assert.equal(config.executionConfigured, false);
  });

  it("uses the paired cloud and durable workspace registry", () => {
    const config = resolveLaunchConfiguration({
      environment: {
        GLASS_NODE_IDENTITY_PATH: "/state/execution-node.json",
        GLASS_EXECUTION_WORKSPACES: '[{"id":"11111111-1111-4111-8111-111111111111"}]',
      },
      readFile: () => JSON.stringify({ apiOrigin: "https://cloud.example" }),
    });
    assert.equal(config.cloudOrigin, "https://cloud.example");
    assert.equal(config.executionConfigured, true);
  });

  it("rejects an execution identity from another cloud", () => {
    assert.throws(
      () =>
        resolveLaunchConfiguration({
          environment: {
            GLASS_CLOUD_ORIGIN: "https://other.example",
            GLASS_EXECUTION_WORKSPACES: "[]",
          },
          readFile: () => JSON.stringify({ apiOrigin: "https://cloud.example" }),
        }),
      /execution identity belongs to https:\/\/cloud\.example/u,
    );
  });
});
