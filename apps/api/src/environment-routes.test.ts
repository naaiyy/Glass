import type { EnvironmentService } from "./environment-service.ts";
import type { GlassAuthRuntimeFactory } from "./auth.ts";
import type { ProductService } from "./product-service.ts";
import { handleRequest } from "./index.ts";
import { describe, expect, it } from "vite-plus/test";

const bindings = {
  ALCHEMY_STAGE: "prod",
  HYPERDRIVE: { connectionString: "postgres://hyperdrive.invalid/glass" },
  BETTER_AUTH_SECRET: "a-secure-test-secret-with-at-least-32-characters",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  CONNECT_NODE_RATE_LIMIT: { limit: async () => ({ success: true }) },
  CONNECT_TICKET_SECRET: "a-connect-ticket-secret-with-at-least-32-bytes",
  CONNECT_AUTHORITY: {
    getByName: () => ({
      issueNodeProofChallenge: async () => null,
      consumeNodeProofChallenge: async () => null,
    }),
  } as never,
  CONNECT_TUNNEL_ZONE_NAME: "glass.test",
  TUNNEL_CONTROL: {
    provision: async () => ({ dnsRecordId: "dns-1", tunnelId: "tunnel-1" }),
    disconnect: async () => undefined,
    delete: async () => undefined,
    token: async () => "tunnel-token",
  },
  TRUST_MUTATION_RATE_LIMIT: { limit: async () => ({ success: true }) },
  TRUST_POLL_RATE_LIMIT: { limit: async () => ({ success: true }) },
} as const;
const organizationId = "11111111-1111-4111-8111-111111111111";
const pairingId = "22222222-2222-4222-8222-222222222222";
const publicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const unusedProduct = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("product service must not be called");
    },
  },
) as ProductService;

const unusedEnvironment: EnvironmentService = {
  beginPairing: async () => {
    throw new Error("must not be called");
  },
  approvePairing: async () => {
    throw new Error("must not be called");
  },
  pairingStatus: async () => {
    throw new Error("must not be called");
  },
  completePairing: async () => {
    throw new Error("must not be called");
  },
  list: async () => {
    throw new Error("must not be called");
  },
  createCredentialChallenge: async () => {
    throw new Error("must not be called");
  },
  exchangeCredential: async () => {
    throw new Error("must not be called");
  },
  revoke: async () => {
    throw new Error("must not be called");
  },
  authorizeUserEnvironment: async () => null,
  hasActiveEnvironment: async () => false,
  verifyCredentialProof: async () => null,
  authenticateCredential: async () => null,
};

const runtime =
  (
    environment: EnvironmentService,
    signedIn: boolean,
    execution?: Awaited<ReturnType<GlassAuthRuntimeFactory>>["execution"],
  ): GlassAuthRuntimeFactory =>
  async () => ({
    environment,
    ...(execution === undefined ? {} : { execution }),
    product: unusedProduct,
    handle: async () => new Response(null, { status: 204 }),
    getSession: async () =>
      signedIn
        ? {
            session: { id: "session", userId: "user-from-session" },
            user: { id: "user-from-session", email: "user@glass.test", name: "User" },
          }
        : null,
    close: async () => undefined,
  });

describe("environment identity API routes", () => {
  it.each([
    "/v1/environment-pairings",
    "/v1/environment-pairings/complete",
    "/v1/environment-credentials/challenges",
    "/v1/environment-credentials/exchange",
  ])("applies the trust-mutation limit to %s", async (pathname) => {
    const response = await handleRequest(
      new Request(`https://api.glass.test${pathname}`, { method: "POST", body: "{}" }),
      {
        ...bindings,
        TRUST_MUTATION_RATE_LIMIT: { limit: async () => ({ success: false }) },
      },
      async () => {
        throw new Error("must not construct runtime");
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("authenticates a node credential before allocating a proof challenge", async () => {
    let allocated = false;
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/connect/node-challenges", {
        method: "POST",
        headers: { authorization: "Bearer invalid" },
        body: JSON.stringify({ environmentId: pairingId, organizationId }),
      }),
      {
        ...bindings,
        CONNECT_AUTHORITY: {
          getByName: () => ({
            issueNodeProofChallenge: async () => {
              allocated = true;
              return null;
            },
          }),
        } as never,
      },
      runtime(unusedEnvironment, false),
    );
    expect(response.status).toBe(401);
    expect(allocated).toBe(false);
  });

  it("rate-limits authenticated node control by environment and credential", async () => {
    let allocated = false;
    let rateKey = "";
    const credential = {
      credentialId: "credential-1",
      environmentId: pairingId,
      organizationId,
      keyVersion: 1,
      scopes: ["execution:connect"],
    } as never;
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/connect/node-challenges", {
        method: "POST",
        headers: { authorization: "Bearer gec_valid" },
        body: JSON.stringify({ environmentId: pairingId, organizationId }),
      }),
      {
        ...bindings,
        CONNECT_NODE_RATE_LIMIT: {
          limit: async ({ key }) => {
            rateKey = key;
            return { success: false };
          },
        },
        CONNECT_AUTHORITY: {
          getByName: () => ({
            issueNodeProofChallenge: async () => {
              allocated = true;
              return null;
            },
          }),
        } as never,
      },
      runtime(
        {
          ...unusedEnvironment,
          authenticateCredential: async () => credential,
        },
        false,
      ),
    );
    expect(response.status).toBe(429);
    expect(rateKey).toBe(`${pairingId}:credential-1`);
    expect(allocated).toBe(false);
  });

  it("applies the independent trust-poll limit", async () => {
    const pathname = "/v1/environment-pairings/status";
    const response = await handleRequest(
      new Request(`https://api.glass.test${pathname}`, { method: "POST", body: "{}" }),
      {
        ...bindings,
        TRUST_MUTATION_RATE_LIMIT: { limit: async () => ({ success: true }) },
        TRUST_POLL_RATE_LIMIT: { limit: async () => ({ success: false }) },
      },
      async () => {
        throw new Error("must not construct runtime");
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("rejects public trust mutations before runtime construction when their limit is exhausted", async () => {
    let runtimeConstructed = false;
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/environment-pairings", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ displayName: "Build Mac", platform: "macos", publicKey }),
      }),
      {
        ...bindings,
        TRUST_MUTATION_RATE_LIMIT: {
          limit: async ({ key }) => {
            expect(key).toBe("api.glass.test:203.0.113.7");
            return { success: false };
          },
        },
      },
      async () => {
        runtimeConstructed = true;
        throw new Error("must not construct runtime");
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ code: "CONFLICT", retryable: true });
    expect(runtimeConstructed).toBe(false);
  });

  it("uses the high-frequency polling bucket independently from mutation traffic", async () => {
    let mutationCalled = false;
    let pollKey: string | undefined;
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/environment-pairings/status", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.9" },
        body: JSON.stringify({ pairingId, pollingToken: "p".repeat(43) }),
      }),
      {
        ...bindings,
        TRUST_MUTATION_RATE_LIMIT: {
          limit: async () => {
            mutationCalled = true;
            return { success: false };
          },
        },
        TRUST_POLL_RATE_LIMIT: {
          limit: async ({ key }) => {
            pollKey = key;
            return { success: true };
          },
        },
      },
      runtime(
        {
          ...unusedEnvironment,
          pairingStatus: async () => ({ status: "pending" }) as never,
        },
        false,
      ),
    );
    expect(response.status).toBe(200);
    expect(pollKey).toBe("api.glass.test:198.51.100.9");
    expect(mutationCalled).toBe(false);
  });

  it("fails closed when node control has no dedicated rate-limit binding", async () => {
    const { CONNECT_NODE_RATE_LIMIT: _omitted, ...missingNodeLimiter } = bindings;
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/connect/node-challenges", {
        method: "POST",
        body: JSON.stringify({ environmentId: pairingId, organizationId }),
      }),
      missingNodeLimiter,
      runtime(unusedEnvironment, false),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
  });

  it("lets an unpaired node begin enrollment without a user credential", async () => {
    const calls: unknown[][] = [];
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/environment-pairings", {
        method: "POST",
        body: JSON.stringify({ displayName: "Build Mac", platform: "macos", publicKey }),
      }),
      bindings,
      runtime(
        {
          ...unusedEnvironment,
          beginPairing: async (...args) => {
            calls.push(args);
            return {
              pairingId,
              pairingCode: "ABCDE-23456",
              pollingToken: "p".repeat(43),
              approvalPath: "/#glass-connect-pair",
              expiresAt: "2026-08-03T12:05:00.000Z",
            } as never;
          },
        },
        false,
      ),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      approvalPath: "/#glass-connect-pair",
      pairingCode: "ABCDE-23456",
    });
    expect(calls).toEqual([[{ displayName: "Build Mac", platform: "macos", publicKey }]]);
  });

  it("requires a Better Auth session before pairing approval", async () => {
    let called = false;
    const request = new Request("https://api.glass.test/v1/environment-pairings/approve", {
      method: "POST",
      body: JSON.stringify({ organizationId, pairingCode: "ABCDE-23456" }),
    });
    const unauthorized = await handleRequest(
      request,
      bindings,
      runtime(
        {
          ...unusedEnvironment,
          approvePairing: async () => {
            called = true;
          },
        },
        false,
      ),
    );
    expect(unauthorized.status).toBe(401);
    expect(called).toBe(false);
  });

  it("derives the approving actor only from the authenticated session", async () => {
    const calls: unknown[][] = [];
    const response = await handleRequest(
      new Request("https://api.glass.test/v1/environment-pairings/approve", {
        method: "POST",
        body: JSON.stringify({ organizationId, pairingCode: "ABCDE-23456" }),
      }),
      bindings,
      runtime(
        {
          ...unusedEnvironment,
          approvePairing: async (...args) => {
            calls.push(args);
          },
        },
        true,
      ),
    );
    expect(response.status).toBe(204);
    expect(calls).toEqual([["user-from-session", { organizationId, pairingCode: "ABCDE-23456" }]]);
  });

  it("permanently revokes Connect authority even when credential invalidation fails", async () => {
    let relayRevoked = false;
    const environmentId = "33333333-3333-4333-8333-333333333333";
    const response = await handleRequest(
      new Request(`https://api.glass.test/v1/environments/${environmentId}`, {
        method: "DELETE",
      }),
      {
        ...bindings,
        CONNECT_AUTHORITY: {
          getByName: () => ({
            revoke: async () => {
              relayRevoked = true;
            },
          }),
        } as never,
      },
      runtime(
        {
          ...unusedEnvironment,
          revoke: async () => ({ id: environmentId }) as never,
        },
        true,
        {
          invalidateEnvironment: async () => {
            throw new Error("credential invalidation failed");
          },
        } as never,
      ),
    );
    expect(response.status).toBe(503);
    expect(relayRevoked).toBe(true);
  });
});
