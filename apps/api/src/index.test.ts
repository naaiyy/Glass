import { describe, expect, it } from "vite-plus/test";
import type { GlassAuthRuntimeFactory } from "./auth.ts";
import type { GlassApiBindingInput } from "./env.ts";
import { handleRequest } from "./index.ts";

const configuredBindings: GlassApiBindingInput = {
  ALCHEMY_STAGE: "prod",
  HYPERDRIVE: { connectionString: "postgres://hyperdrive.invalid/glass" },
  BETTER_AUTH_SECRET: "a-secure-test-secret-with-at-least-32-characters",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
};

describe("Glass Cloud API boundary", () => {
  it("exposes an honest foundation descriptor", async () => {
    const response = await handleRequest(new Request("https://glass.invalid/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      architecture: { kind: "glass-cloud", status: "foundation" },
      service: "glass-api",
    });
  });

  it("keeps health available without database or authentication bindings", () => {
    const response = handleRequest(new Request("https://glass.invalid/health"));
    expect(response).toBeInstanceOf(Response);
  });

  it("fails auth routes honestly before constructing a runtime when bindings are absent", async () => {
    let factoryCalled = false;
    const factory: GlassAuthRuntimeFactory = async () => {
      factoryCalled = true;
      throw new Error("must not be called");
    };

    const response = await handleRequest(
      new Request("https://glass.invalid/api/auth/session"),
      undefined,
      factory,
    );

    expect(response.status).toBe(503);
    expect(factoryCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
  });

  it("delegates Better Auth requests and closes the request-scoped database runtime", async () => {
    const request = new Request("https://glass.invalid/api/auth/sign-in/social", {
      method: "POST",
    });
    let handledRequest: Request | undefined;
    let closed = false;
    const factory: GlassAuthRuntimeFactory = async () => ({
      handle: async (received) => {
        handledRequest = received;
        return new Response(null, { status: 204 });
      },
      getSession: async () => null,
      close: async () => {
        closed = true;
      },
    });

    const response = await handleRequest(request, configuredBindings, factory);

    expect(response.status).toBe(204);
    expect(handledRequest).toBe(request);
    expect(closed).toBe(true);
  });

  it("requires a durable Better Auth session for the protected proof route", async () => {
    let closed = false;
    const factory: GlassAuthRuntimeFactory = async () => ({
      handle: async () => new Response(null, { status: 204 }),
      getSession: async () => null,
      close: async () => {
        closed = true;
      },
    });

    const response = await handleRequest(
      new Request("https://glass.invalid/v1/authenticated-proof"),
      configuredBindings,
      factory,
    );

    expect(response.status).toBe(401);
    expect(closed).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("derives protected identity only from the Better Auth session", async () => {
    const factory: GlassAuthRuntimeFactory = async () => ({
      handle: async () => new Response(null, { status: 204 }),
      getSession: async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1", email: "glass@example.test", name: "Glass User" },
      }),
      close: async () => undefined,
    });

    const response = await handleRequest(
      new Request("https://glass.invalid/v1/authenticated-proof", {
        headers: { cookie: "better-auth.session_token=opaque" },
      }),
      configuredBindings,
      factory,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      authority: "glass-cloud",
      userId: "user-1",
    });
  });
});
