import { assert, describe, it } from "vite-plus/test";

import {
  parseDevelopmentSurface,
  parseMetroPort,
  parseWebPort,
  resolveCloudOrigin,
  resolveLaunchConfiguration,
} from "./dev-runner.mjs";

const missing = () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  throw error;
};

describe("Glass development launcher", () => {
  it("uses the local API when no identity exists", () => {
    const config = resolveLaunchConfiguration({
      environment: {},
      fileExists: () => false,
      readFile: missing,
    });
    assert.equal(config.cloudOrigin, "http://127.0.0.1:8787");
    assert.equal(config.executionConfigured, false);
    assert.match(config.identityPath, /\.glass\/local\/main\/execution-node\.json$/u);
  });

  it("starts a paired environment before any workspace is registered", () => {
    const config = resolveLaunchConfiguration({
      environment: {
        GLASS_CLOUD_ORIGIN: "https://cloud.example",
        GLASS_NODE_IDENTITY_PATH: "/state/execution-node.json",
      },
      fileExists: () => false,
      readFile: () =>
        JSON.stringify({ apiOrigin: "https://cloud.example", environment: { id: "environment" } }),
    });
    assert.equal(config.cloudOrigin, "https://cloud.example");
    assert.equal(config.executionConfigured, true);
  });

  it("does not connect a pairing identity before publication completes", () => {
    const config = resolveLaunchConfiguration({
      environment: { GLASS_CLOUD_ORIGIN: "https://cloud.example" },
      readFile: () => JSON.stringify({ apiOrigin: "https://cloud.example", environment: null }),
    });
    assert.equal(config.hasIdentity, true);
    assert.equal(config.hasPublishedIdentity, false);
    assert.equal(config.executionConfigured, false);
  });

  it("does not let an unrelated execution identity block the product connection", () => {
    const config = resolveLaunchConfiguration({
      environment: {
        GLASS_CLOUD_ORIGIN: "https://other.example",
        GLASS_EXECUTION_WORKSPACES: "[]",
      },
      fileExists: () => false,
      readFile: () =>
        JSON.stringify({ apiOrigin: "https://cloud.example", environment: { id: "environment" } }),
    });
    assert.equal(config.cloudOrigin, "https://other.example");
    assert.equal(config.identityMatchesCloud, false);
    assert.equal(config.executionConfigured, false);
  });

  it("never selects a deployment from an ambient execution identity", () => {
    const config = resolveLaunchConfiguration({
      environment: {},
      fileExists: () => false,
      readFile: () => JSON.stringify({ apiOrigin: "https://production.example" }),
    });
    assert.equal(config.cloudOrigin, "http://127.0.0.1:8787");
  });

  it("accepts only complete client surfaces", () => {
    assert.equal(parseDevelopmentSurface(undefined), "web");
    assert.equal(parseDevelopmentSurface("api"), "api");
    assert.equal(parseDevelopmentSurface("desktop"), "desktop");
    assert.equal(parseDevelopmentSurface("mobile"), "mobile");
    assert.equal(parseDevelopmentSurface("mobile-ios"), "mobile-ios");
    assert.throws(() => parseDevelopmentSurface("renderer"), /Unknown Glass development surface/u);
  });

  it("validates an explicit web port before spawning Vite", () => {
    assert.equal(parseWebPort(undefined), 5173);
    assert.equal(parseWebPort("5199"), 5199);
    assert.throws(() => parseWebPort("not-a-port"), /GLASS_DEV_WEB_PORT/u);
    assert.equal(parseWebPort("65535"), 65_535);
    assert.throws(() => parseWebPort("65536"), /GLASS_DEV_WEB_PORT/u);
  });

  it("validates an explicit Metro port before spawning Expo", () => {
    assert.equal(parseMetroPort(undefined), 8081);
    assert.equal(parseMetroPort("8099"), 8099);
    assert.throws(() => parseMetroPort("none"), /GLASS_DEV_METRO_PORT/u);
    assert.throws(() => parseMetroPort("0"), /GLASS_DEV_METRO_PORT/u);
  });

  it("accepts only safe Glass Cloud origins", () => {
    assert.equal(resolveCloudOrigin("https://cloud.example/"), "https://cloud.example");
    assert.equal(resolveCloudOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
    assert.throws(() => resolveCloudOrigin("http://cloud.example"), /Glass Cloud/u);
    assert.throws(() => resolveCloudOrigin("https://cloud.example/path"), /Glass Cloud/u);
    assert.throws(() => resolveCloudOrigin("https://user:secret@cloud.example"), /Glass Cloud/u);
  });
});
