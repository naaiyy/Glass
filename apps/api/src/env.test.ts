import { describe, expect, it } from "vite-plus/test";

import { resolveGlassAuthConfig, type GlassApiBindingInput } from "./env.ts";

const validBindings: GlassApiBindingInput = {
  ALCHEMY_STAGE: "prod",
  HYPERDRIVE: { connectionString: "postgres://hyperdrive.invalid/glass" },
  BETTER_AUTH_SECRET: "a-secure-test-secret-with-at-least-32-characters",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  CONNECT_NODE_RATE_LIMIT: { limit: async () => ({ success: true }) },
  CONNECT_TUNNEL_ZONE_NAME: "glass.test",
  TUNNEL_CONTROL: {
    provision: async () => ({ dnsRecordId: "dns-1", tunnelId: "tunnel-1" }),
    disconnect: async () => undefined,
    delete: async () => undefined,
    token: async () => "token",
  },
};

describe("Glass API authentication bindings", () => {
  it("scopes Better Auth host resolution to the deployed Alchemy stage", () => {
    expect(resolveGlassAuthConfig(validBindings)).toEqual({
      ok: true,
      config: {
        allowedHosts: ["glasscloud-api-prod-*.workers.dev"],
        connectionString: "postgres://hyperdrive.invalid/glass",
        trustedOrigins: ["dev.glass.desktop://*", "dev.glass.mobile://*"],
        secret: "a-secure-test-secret-with-at-least-32-characters",
        stage: "prod",
        tunnelZoneName: "glass.test",
        github: {
          clientId: "github-client-id",
          clientSecret: "github-client-secret",
        },
      },
    });
  });

  it("rejects unknown or missing deployment stages", () => {
    expect(
      resolveGlassAuthConfig({
        ...validBindings,
        ALCHEMY_STAGE: "preview",
      }),
    ).toEqual({
      ok: false,
      missingOrInvalidBindings: ["ALCHEMY_STAGE"],
    });
  });

  it("reports binding names, never values, when durable auth configuration is invalid", () => {
    expect(
      resolveGlassAuthConfig({
        ...validBindings,
        BETTER_AUTH_SECRET: "short",
        GITHUB_CLIENT_SECRET: "",
      }),
    ).toEqual({
      ok: false,
      missingOrInvalidBindings: ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_SECRET"],
    });
  });
});
