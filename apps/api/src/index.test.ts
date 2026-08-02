import { describe, expect, it } from "vite-plus/test";
import { maxNoteContentEnvelopeBytes } from "@glass/contracts/notes";
import { maxPushRequestBytes } from "@glass/contracts/sync";
import type { GlassAuthRuntimeFactory } from "./auth.ts";
import type { GlassApiBindingInput } from "./env.ts";
import { handleRequest } from "./index.ts";
import { ProductFailure, type ProductFailureCode, type ProductService } from "./product-service.ts";

const unusedProduct: ProductService = {
  listOrganizations: async () => {
    throw new Error("product service must not be called");
  },
  loadNoteContent: async () => {
    throw new Error("product service must not be called");
  },
  pull: async () => {
    throw new Error("product service must not be called");
  },
  push: async () => {
    throw new Error("product service must not be called");
  },
  saveNoteContent: async () => {
    throw new Error("product service must not be called");
  },
  snapshot: async () => {
    throw new Error("product service must not be called");
  },
};

const configuredBindings: GlassApiBindingInput = {
  ALCHEMY_STAGE: "prod",
  HYPERDRIVE: { connectionString: "postgres://hyperdrive.invalid/glass" },
  BETTER_AUTH_SECRET: "a-secure-test-secret-with-at-least-32-characters",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
};

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const commandId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const noteId = "44444444-4444-4444-8444-444444444444";

const authenticatedFactory =
  (product: ProductService): GlassAuthRuntimeFactory =>
  async () => ({
    product,
    handle: async () => new Response(null, { status: 204 }),
    getSession: async () => ({
      session: { id: "session-1", userId: "user-from-session" },
      user: { id: "user-from-session", email: "glass@example.test", name: "Glass User" },
    }),
    close: async () => undefined,
  });

describe("Glass Cloud API boundary", () => {
  it("exposes an honest durable product descriptor", async () => {
    const response = await handleRequest(new Request("https://glass.invalid/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      architecture: { kind: "glass-cloud", status: "durable-product-core" },
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
      product: unusedProduct,
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

  it("distinguishes runtime construction failures from auth handler failures", async () => {
    const originalConsoleError = console.error;
    const reportedFailures: unknown[][] = [];
    console.error = (...values: unknown[]) => {
      reportedFailures.push(values);
    };
    try {
      const unavailable = await handleRequest(
        new Request("https://glass.invalid/api/auth/session"),
        configuredBindings,
        async () => {
          throw new Error("database unavailable");
        },
      );

      expect(unavailable.status).toBe(503);
      await expect(unavailable.json()).resolves.toMatchObject({
        code: "PRODUCT_UNAVAILABLE",
        retryable: true,
      });

      let closed = false;
      const failed = await handleRequest(
        new Request("https://glass.invalid/api/auth/session"),
        configuredBindings,
        async () => ({
          product: unusedProduct,
          handle: async () => {
            throw new Error("handler failure");
          },
          getSession: async () => null,
          close: async () => {
            closed = true;
          },
        }),
      );

      expect(failed.status).toBe(500);
      expect(closed).toBe(true);
      await expect(failed.json()).resolves.toMatchObject({
        code: "INVALID_RESPONSE",
        retryable: false,
      });
      expect(reportedFailures).toEqual([
        [
          "Glass Cloud authentication boundary failed.",
          { phase: "construction", errorType: "Error" },
        ],
        ["Glass Cloud authentication boundary failed.", { phase: "request", errorType: "Error" }],
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("requires a durable Better Auth session for the protected proof route", async () => {
    let closed = false;
    const factory: GlassAuthRuntimeFactory = async () => ({
      product: unusedProduct,
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
      product: unusedProduct,
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

  it("requires a durable session before invoking a product service", async () => {
    let productCalled = false;
    const product: ProductService = {
      listOrganizations: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
      loadNoteContent: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
      pull: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
      push: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
      saveNoteContent: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
      snapshot: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
    };
    const factory: GlassAuthRuntimeFactory = async () => ({
      product,
      handle: async () => new Response(null, { status: 204 }),
      getSession: async () => null,
      close: async () => undefined,
    });

    const response = await handleRequest(
      new Request(`https://glass.invalid/v1/sync/snapshot?organizationId=${organizationId}`),
      configuredBindings,
      factory,
    );

    expect(response.status).toBe(401);
    expect(productCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("discovers organizations for the authenticated user with a bounded keyset request", async () => {
    const calls: unknown[][] = [];
    const timestamp = "2026-08-02T12:00:00.000Z";
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/organizations?limit=25"),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        listOrganizations: async (...values) => {
          calls.push(values);
          return {
            items: [
              {
                organization: {
                  id: organizationId,
                  name: "Glass",
                  version: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
                membership: {
                  organizationId,
                  userId: "55555555-5555-4555-8555-555555555555",
                  role: "owner",
                  version: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              },
            ],
            nextCursor: organizationId,
          } as never;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([["user-from-session", { after: null, limit: 25 }]]);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ organization: { id: organizationId }, membership: { organizationId } }],
      nextCursor: organizationId,
    });
  });

  it("rejects malformed or ambiguous organization discovery queries before delegation", async () => {
    let called = false;
    const product = {
      ...unusedProduct,
      listOrganizations: async () => {
        called = true;
        return { items: [], nextCursor: null };
      },
    } satisfies ProductService;
    const oversized = await handleRequest(
      new Request("https://glass.invalid/v1/organizations?limit=101"),
      configuredBindings,
      authenticatedFactory(product),
    );
    const duplicated = await handleRequest(
      new Request("https://glass.invalid/v1/organizations?limit=1&limit=2"),
      configuredBindings,
      authenticatedFactory(product),
    );

    expect(oversized.status).toBe(422);
    expect(duplicated.status).toBe(422);
    expect(called).toBe(false);
  });

  it("validates every command organization scope before delegation", async () => {
    let productCalled = false;
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          commands: [
            {
              commandId,
              organizationId: otherOrganizationId,
              operation: { kind: "project.create", projectId, name: "Project", description: null },
            },
          ],
        }),
      }),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        push: async () => {
          productCalled = true;
          return { results: [] };
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(productCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: "$push.commands" }],
    });
  });

  it("rejects malformed JSON as a typed product error", async () => {
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        method: "POST",
        body: "{",
      }),
      configuredBindings,
      authenticatedFactory(unusedProduct),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_FAILED",
      message: "The product request body is not valid JSON.",
      retryable: false,
    });
  });

  it("rejects an oversized push envelope before durable delegation", async () => {
    let productCalled = false;
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        method: "POST",
        headers: { "content-length": String(maxPushRequestBytes + 1) },
        body: "{}",
      }),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        push: async () => {
          productCalled = true;
          throw new Error("must not be called");
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(productCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      message: "The product request body is too large.",
    });
  });

  it("loads note content through the authenticated durable service", async () => {
    const calls: unknown[][] = [];
    const response = await handleRequest(
      new Request(
        `https://glass.invalid/v1/notes/content?organizationId=${organizationId}&noteId=${noteId}`,
      ),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        loadNoteContent: async (...values) => {
          calls.push(values);
          return {
            organizationId,
            noteId,
            content: { type: "doc", version: 1, content: [] },
            savedAt: "2026-08-02T12:00:00.000Z",
            savedByUserId: "55555555-5555-4555-8555-555555555555",
          } as never;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([["user-from-session", { organizationId, noteId }]]);
    await expect(response.json()).resolves.toMatchObject({
      organizationId,
      noteId,
      savedByUserId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("rejects unknown and duplicate note query parameters before delegation", async () => {
    let called = false;
    const product = {
      ...unusedProduct,
      loadNoteContent: async () => {
        called = true;
        throw new Error("must not be called");
      },
    } satisfies ProductService;
    for (const query of [
      `organizationId=${organizationId}&noteId=${noteId}&unknown=1`,
      `organizationId=${organizationId}&noteId=${noteId}&noteId=${noteId}`,
      `organizationId=${organizationId}`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await handleRequest(
        new Request(`https://glass.invalid/v1/notes/content?${query}`),
        configuredBindings,
        authenticatedFactory(product),
      );
      expect(response.status).toBe(422);
    }
    expect(called).toBe(false);
  });

  it("rejects malformed UTF-8 before JSON decoding or durable delegation", async () => {
    let called = false;
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
        method: "POST",
      }),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        push: async () => {
          called = true;
          throw new Error("must not be called");
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      message: "The product request body is not valid UTF-8.",
    });
  });

  it("validates and normalizes a whole note snapshot before saving", async () => {
    const calls: unknown[][] = [];
    const body = {
      organizationId,
      noteId,
      content: { type: "doc", version: 1, content: [{ type: "paragraph" }] },
    };
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/notes/content", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        saveNoteContent: async (...values) => {
          calls.push(values);
          return {
            organizationId,
            noteId,
            savedAt: "2026-08-02T12:00:00.000Z",
            savedByUserId: "55555555-5555-4555-8555-555555555555",
          } as never;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("user-from-session");
    expect(calls[0]?.[1]).toMatchObject({ organizationId, noteId, content: { version: 1 } });
  });

  it("rejects invalid and oversized note snapshots before durable storage", async () => {
    let productCalled = false;
    const factory = authenticatedFactory({
      ...unusedProduct,
      saveNoteContent: async () => {
        productCalled = true;
        throw new Error("must not be called");
      },
    });
    const invalid = await handleRequest(
      new Request("https://glass.invalid/v1/notes/content", {
        method: "PUT",
        body: JSON.stringify({ organizationId, noteId, content: { type: "doc", version: 2 } }),
      }),
      configuredBindings,
      factory,
    );
    expect(invalid.status).toBe(422);

    const oversized = await handleRequest(
      new Request("https://glass.invalid/v1/notes/content", {
        method: "PUT",
        body: JSON.stringify({
          organizationId,
          noteId,
          content: "x".repeat(maxNoteContentEnvelopeBytes),
        }),
      }),
      configuredBindings,
      factory,
    );
    expect(oversized.status).toBe(422);
    await expect(oversized.json()).resolves.toMatchObject({
      message: "The note content request body is too large.",
    });
    expect(productCalled).toBe(false);
  });

  it("cancels an oversized chunked note body before buffering beyond the ingress bound", async () => {
    let cancelled = false;
    let firstChunkSent = false;
    let productCalled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!firstChunkSent) {
          firstChunkSent = true;
          controller.enqueue(new Uint8Array(maxNoteContentEnvelopeBytes));
          return;
        }
        controller.enqueue(new Uint8Array([120, 120]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://glass.invalid/v1/notes/content", {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleRequest(
      request,
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        saveNoteContent: async () => {
          productCalled = true;
          throw new Error("must not be called");
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(cancelled).toBe(true);
    expect(productCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      message: "The note content request body is too large.",
    });
  });

  it("validates snapshot organization identifiers before delegation", async () => {
    let productCalled = false;
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/snapshot?organizationId=not-an-id"),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        snapshot: async () => {
          productCalled = true;
          throw new Error("must not be called");
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(productCalled).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_FAILED",
      issues: [{ path: "$snapshotPage.organizationId" }],
    });
  });

  it("delegates session identity and the validated organization scope", async () => {
    const calls: unknown[][] = [];
    const product: ProductService = {
      ...unusedProduct,
      push: async (...values) => {
        calls.push(values);
        return { results: [] };
      },
    };
    const body = {
      organizationId,
      commands: [
        {
          commandId,
          organizationId,
          operation: { kind: "project.create", projectId, name: "Project", description: null },
        },
      ],
    };
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      configuredBindings,
      authenticatedFactory(product),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([["user-from-session", body]]);
  });

  it("delegates a bounded pull through the requested stable event head", async () => {
    const calls: unknown[][] = [];
    const response = await handleRequest(
      new Request(
        `https://glass.invalid/v1/sync/pull?organizationId=${organizationId}&after=2&through=4&limit=10`,
      ),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        pull: async (...values) => {
          calls.push(values);
          return {
            events: [],
            hasMore: false,
            nextCursor: "2",
            head: {
              organizationId,
              cursor: "4",
              capturedAt: "2026-08-02T00:00:00.000Z",
            },
          } as never;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      ["user-from-session", { organizationId, after: "2", through: "4", limit: 10 }],
    ]);
  });

  it("rejects unknown, duplicate, and incomplete synchronization query parameters", async () => {
    let called = false;
    const product = {
      ...unusedProduct,
      pull: async () => {
        called = true;
        throw new Error("must not be called");
      },
      snapshot: async () => {
        called = true;
        throw new Error("must not be called");
      },
    } satisfies ProductService;
    const urls = [
      `/v1/sync/pull?organizationId=${organizationId}&limit=1&limit=2`,
      `/v1/sync/pull?organizationId=${organizationId}&unknown=1`,
      `/v1/sync/snapshot?organizationId=${organizationId}&afterId=${projectId}`,
      `/v1/sync/snapshot?organizationId=${organizationId}&unknown=1`,
    ];
    for (const path of urls) {
      // eslint-disable-next-line no-await-in-loop
      const response = await handleRequest(
        new Request(`https://glass.invalid${path}`),
        configuredBindings,
        authenticatedFactory(product),
      );
      expect(response.status).toBe(422);
    }
    expect(called).toBe(false);
  });

  it("delegates a typed message snapshot continuation at its pinned head", async () => {
    const calls: unknown[][] = [];
    const timestamp = "2026-08-02T12:00:00.000Z";
    const threadId = "55555555-5555-4555-8555-555555555555";
    const messageId = "66666666-6666-4666-8666-666666666666";
    const response = await handleRequest(
      new Request(
        `https://glass.invalid/v1/sync/snapshot?organizationId=${organizationId}&through=42&afterSection=message&afterThreadId=${threadId}&afterOrdinal=9007199254740993&afterId=${messageId}&limit=10`,
      ),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        snapshot: async (...values) => {
          calls.push(values);
          return {
            organization: {
              id: organizationId,
              name: "Glass",
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            head: { organizationId, cursor: "42", capturedAt: timestamp },
            entities: [],
            hasMore: false,
            next: null,
          } as never;
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      [
        "user-from-session",
        {
          organizationId,
          through: "42",
          after: {
            section: "message",
            threadId,
            ordinal: "9007199254740993",
            id: messageId,
          },
          limit: 10,
        },
      ],
    ]);
  });

  it("rejects a wire-invalid product service response", async () => {
    const response = await handleRequest(
      new Request("https://glass.invalid/v1/sync/push", {
        method: "POST",
        body: JSON.stringify({
          organizationId,
          commands: [
            {
              commandId,
              organizationId,
              operation: {
                kind: "project.create",
                projectId,
                name: "Project",
                description: null,
              },
            },
          ],
        }),
      }),
      configuredBindings,
      authenticatedFactory({
        ...unusedProduct,
        push: async () =>
          ({ results: [{ status: "accepted", commandId, cursor: "bad", eventCount: 0 }] }) as never,
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("reports an unexpected durable product failure as retryable unavailability", async () => {
    const originalConsoleError = console.error;
    const reportedFailures: unknown[][] = [];
    console.error = (...values: unknown[]) => {
      reportedFailures.push(values);
    };
    try {
      const response = await handleRequest(
        new Request(`https://glass.invalid/v1/sync/snapshot?organizationId=${organizationId}`),
        configuredBindings,
        authenticatedFactory({
          ...unusedProduct,
          snapshot: async () => {
            throw new Error("database unavailable");
          },
        }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        code: "PRODUCT_UNAVAILABLE",
        message: "Glass Cloud could not reach durable product storage.",
        retryable: true,
      });
      expect(reportedFailures).toEqual([
        ["Glass Cloud product boundary failed.", { errorType: "Error" }],
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it.each<readonly [ProductFailureCode, number, string]>([
    ["conflict", 409, "CONFLICT"],
    ["cursor-expired", 410, "CURSOR_EXPIRED"],
    ["cursor-invalid", 409, "CURSOR_INVALID"],
    ["forbidden", 403, "FORBIDDEN"],
    ["invalid", 422, "VALIDATION_FAILED"],
    ["not-found", 404, "NOT_FOUND"],
  ])("maps the %s product failure at the HTTP boundary", async (failure, status, code) => {
    const product: ProductService = {
      ...unusedProduct,
      snapshot: async () => {
        throw new ProductFailure(failure, "Safe product failure.", {
          commandId,
          currentVersion: 7,
          retryable: failure === "conflict",
        });
      },
    };
    const response = await handleRequest(
      new Request(`https://glass.invalid/v1/sync/snapshot?organizationId=${organizationId}`),
      configuredBindings,
      authenticatedFactory(product),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      code,
      message: "Safe product failure.",
      retryable: failure === "conflict",
      commandId,
      currentVersion: 7,
    });
  });
});
