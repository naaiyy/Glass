import { glassProtocolVersion, type HealthDescriptor } from "@glass/contracts/architecture";
import type { BoundaryError } from "@glass/contracts/errors";
import {
  decodeLoadNoteContentRequest,
  decodeNoteContentResponse,
  decodeSaveNoteContentRequest,
  decodeSaveNoteContentResponse,
  maxNoteContentEnvelopeBytes,
} from "@glass/contracts/notes";
import {
  decodeListOrganizationsRequest,
  decodeOrganizationsPage,
  defaultOrganizationsPageLimit,
} from "@glass/contracts/organizations";
import {
  decodePullEventsRequest,
  decodePullEventsResponse,
  decodePushCommandsRequest,
  decodePushCommandsResponse,
  decodeSnapshotPageRequest,
  decodeSnapshotPageResponse,
  maxPullEvents,
  maxPushRequestBytes,
  maxSnapshotEntities,
} from "@glass/contracts/sync";

import {
  createGlassAuthRuntime,
  type GlassAuthRuntime,
  type GlassAuthRuntimeFactory,
} from "./auth.ts";
import {
  resolveGlassAuthConfig,
  type GlassApiBindingInput,
  type GlassApiBindings,
  type GlassAuthConfig,
} from "./env.ts";
import { ProductFailure } from "./product-service.ts";

const health: HealthDescriptor = {
  service: "glass-api",
  status: "ok",
  architecture: {
    kind: "glass-cloud",
    protocolVersion: glassProtocolVersion,
    status: "durable-product-core",
  },
};

const notFound: BoundaryError = {
  code: "INVALID_RESPONSE",
  message: "The requested API foundation route does not exist.",
  retryable: false,
};

const productUnavailable: BoundaryError = {
  code: "PRODUCT_UNAVAILABLE",
  message: "Glass Cloud is unavailable because its durable runtime is not configured.",
  retryable: true,
};

const productRequestUnavailable: BoundaryError = {
  code: "PRODUCT_UNAVAILABLE",
  message: "Glass Cloud could not reach durable product storage.",
  retryable: true,
};

const authRequestFailed: BoundaryError = {
  code: "INVALID_RESPONSE",
  message: "Glass Cloud authentication could not process the request.",
  retryable: false,
};

const unauthorized: BoundaryError = {
  code: "UNAUTHENTICATED",
  message: "A valid Glass Cloud session is required.",
  retryable: false,
};

const invalidRequest: BoundaryError = {
  code: "VALIDATION_FAILED",
  message: "The product request is invalid.",
  retryable: false,
};

const invalidProductResponse: BoundaryError = {
  code: "INVALID_RESPONSE",
  message: "Glass Cloud produced an invalid product response.",
  retryable: true,
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const reportAuthFailure = (phase: "construction" | "request", cause: unknown): void => {
  console.error("Glass Cloud authentication boundary failed.", {
    phase,
    errorType: cause instanceof Error ? cause.name : "UnknownFailure",
  });
};

const isAuthRoute = (pathname: string): boolean =>
  pathname === "/api/auth" || pathname.startsWith("/api/auth/");

const productErrorResponse = (cause: unknown): Response => {
  if (!(cause instanceof ProductFailure)) throw cause;
  const statusByCode = {
    conflict: 409,
    "cursor-expired": 410,
    "cursor-invalid": 409,
    forbidden: 403,
    invalid: 422,
    "not-found": 404,
  } as const;
  const codeByFailure = {
    conflict: "CONFLICT",
    "cursor-expired": "CURSOR_EXPIRED",
    "cursor-invalid": "CURSOR_INVALID",
    forbidden: "FORBIDDEN",
    invalid: "VALIDATION_FAILED",
    "not-found": "NOT_FOUND",
  } as const;
  return json(
    {
      code: codeByFailure[cause.code],
      message: cause.message,
      retryable: cause.retryable,
      ...(cause.commandId === null ? {} : { commandId: cause.commandId }),
      ...(cause.currentVersion === null ? {} : { currentVersion: cause.currentVersion }),
    },
    statusByCode[cause.code],
  );
};

const readJsonBody = async (
  request: Request,
  maximumBytes = maxPushRequestBytes,
  message = "The product request body is too large.",
): Promise<unknown> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new ProductFailure("invalid", message);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  if (reader !== undefined) {
    while (true) {
      // The body is consumed incrementally so a chunked request cannot allocate beyond its bound.
      // eslint-disable-next-line no-await-in-loop
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel("Request body exceeds its durable boundary.");
        throw new ProductFailure("invalid", message);
      }
      chunks.push(next.value);
    }
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProductFailure("invalid", "The product request body is not valid UTF-8.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProductFailure("invalid", "The product request body is not valid JSON.");
  }
};

const handleProductRoute = (
  request: Request,
  url: URL,
  runtime: GlassAuthRuntime,
  userId: string,
): Promise<Response> => {
  if (request.method === "GET" && url.pathname === "/v1/organizations") {
    const queryKeys = [...url.searchParams.keys()];
    const invalidQuery =
      queryKeys.some((key) => key !== "after" && key !== "limit") ||
      url.searchParams.getAll("after").length > 1 ||
      url.searchParams.getAll("limit").length > 1;
    if (invalidQuery) return Promise.resolve(json(invalidRequest, 422));
    const decoded = decodeListOrganizationsRequest({
      after: url.searchParams.get("after"),
      limit:
        url.searchParams.get("limit") === null
          ? defaultOrganizationsPageLimit
          : Number(url.searchParams.get("limit")),
    });
    if (!decoded.ok)
      return Promise.resolve(json({ ...invalidRequest, issues: decoded.issues }, 422));
    return runtime.product.listOrganizations(userId, decoded.value).then((result) => {
      const validated = decodeOrganizationsPage(result);
      return validated.ok
        ? json(validated.value)
        : json({ ...invalidProductResponse, issues: validated.issues }, 500);
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/notes/content") {
    const noteQueryKeys = [...url.searchParams.keys()];
    const invalidNoteQuery =
      noteQueryKeys.some((key) => key !== "noteId" && key !== "organizationId") ||
      url.searchParams.getAll("noteId").length !== 1 ||
      url.searchParams.getAll("organizationId").length !== 1;
    if (invalidNoteQuery) return Promise.resolve(json(invalidRequest, 422));
    const decoded = decodeLoadNoteContentRequest({
      organizationId: url.searchParams.get("organizationId"),
      noteId: url.searchParams.get("noteId"),
    });
    if (!decoded.ok)
      return Promise.resolve(json({ ...invalidRequest, issues: decoded.issues }, 422));
    return runtime.product.loadNoteContent(userId, decoded.value).then((result) => {
      const validated = decodeNoteContentResponse(result);
      return validated.ok
        ? json(validated.value)
        : json({ ...invalidProductResponse, issues: validated.issues }, 500);
    });
  }

  if (request.method === "PUT" && url.pathname === "/v1/notes/content") {
    return readJsonBody(
      request,
      maxNoteContentEnvelopeBytes,
      "The note content request body is too large.",
    ).then(async (body) => {
      const decoded = decodeSaveNoteContentRequest(body);
      if (!decoded.ok) return json({ ...invalidRequest, issues: decoded.issues }, 422);
      const result = decodeSaveNoteContentResponse(
        await runtime.product.saveNoteContent(userId, decoded.value),
      );
      return result.ok
        ? json(result.value)
        : json({ ...invalidProductResponse, issues: result.issues }, 500);
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/sync/push") {
    return readJsonBody(request).then(async (body) => {
      const decoded = decodePushCommandsRequest(body);
      if (!decoded.ok) return json({ ...invalidRequest, issues: decoded.issues }, 422);
      const result = decodePushCommandsResponse(await runtime.product.push(userId, decoded.value));
      return result.ok
        ? json(result.value)
        : json({ ...invalidProductResponse, issues: result.issues }, 500);
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/sync/pull") {
    const pullQueryKeys = new Set(["after", "limit", "organizationId", "through"]);
    const invalidPullQuery =
      [...url.searchParams.keys()].some((key) => !pullQueryKeys.has(key)) ||
      [...pullQueryKeys].some((key) => url.searchParams.getAll(key).length > 1);
    if (invalidPullQuery) return Promise.resolve(json(invalidRequest, 422));
    const decoded = decodePullEventsRequest({
      organizationId: url.searchParams.get("organizationId"),
      after: url.searchParams.get("after"),
      through: url.searchParams.get("through"),
      limit: Number(url.searchParams.get("limit") ?? Math.min(200, maxPullEvents)),
    });
    if (!decoded.ok)
      return Promise.resolve(json({ ...invalidRequest, issues: decoded.issues }, 422));
    return runtime.product.pull(userId, decoded.value).then((result) => {
      const validated = decodePullEventsResponse(result);
      return validated.ok
        ? json(validated.value)
        : json({ ...invalidProductResponse, issues: validated.issues }, 500);
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/sync/snapshot") {
    const snapshotQueryKeys = new Set([
      "afterId",
      "afterOrdinal",
      "afterSection",
      "afterThreadId",
      "limit",
      "organizationId",
      "through",
    ]);
    const invalidSnapshotQuery =
      [...url.searchParams.keys()].some((key) => !snapshotQueryKeys.has(key)) ||
      [...snapshotQueryKeys].some((key) => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.get("afterSection") === null &&
        ["afterId", "afterOrdinal", "afterThreadId"].some(
          (key) => url.searchParams.get(key) !== null,
        ));
    if (invalidSnapshotQuery) return Promise.resolve(json(invalidRequest, 422));
    const afterSection = url.searchParams.get("afterSection");
    const after =
      afterSection === null
        ? null
        : afterSection === "message"
          ? {
              section: afterSection,
              id: url.searchParams.get("afterId"),
              threadId: url.searchParams.get("afterThreadId"),
              ordinal: url.searchParams.get("afterOrdinal"),
            }
          : { section: afterSection, id: url.searchParams.get("afterId") };
    const decoded = decodeSnapshotPageRequest({
      organizationId: url.searchParams.get("organizationId"),
      through: url.searchParams.get("through"),
      after,
      limit: Number(url.searchParams.get("limit") ?? Math.min(200, maxSnapshotEntities)),
    });
    if (!decoded.ok)
      return Promise.resolve(json({ ...invalidRequest, issues: decoded.issues }, 422));
    return runtime.product.snapshot(userId, decoded.value).then((result) => {
      const validated = decodeSnapshotPageResponse(result, decoded.value);
      return validated.ok
        ? json(validated.value)
        : json({ ...invalidProductResponse, issues: validated.issues }, 500);
    });
  }

  return Promise.resolve(json(notFound, 404));
};

const withAuthRuntime = async (
  config: GlassAuthConfig,
  createRuntime: GlassAuthRuntimeFactory,
  useRuntime: (runtime: GlassAuthRuntime) => Promise<Response>,
): Promise<Response> => {
  let runtime: GlassAuthRuntime;
  try {
    runtime = await createRuntime(config);
  } catch (cause) {
    reportAuthFailure("construction", cause);
    return json(productUnavailable, 503);
  }

  try {
    return await useRuntime(runtime);
  } catch (cause) {
    reportAuthFailure("request", cause);
    return json(authRequestFailed, 500);
  } finally {
    try {
      await runtime.close();
    } catch {
      // The response is already determined; a failed connection close must not replace it.
    }
  }
};

const handleAuthenticatedRoute = (
  request: Request,
  config: GlassAuthConfig,
  createRuntime: GlassAuthRuntimeFactory,
  url: URL,
): Promise<Response> =>
  withAuthRuntime(config, createRuntime, async (runtime) => {
    const session = await runtime.getSession(request.headers);
    if (!session) {
      return json(unauthorized, 401);
    }
    if (request.method === "GET" && url.pathname === "/v1/authenticated-proof") {
      return json({
        authenticated: true,
        authority: "glass-cloud",
        userId: session.user.id,
      });
    }
    try {
      return await handleProductRoute(request, url, runtime, session.user.id);
    } catch (cause) {
      if (cause instanceof ProductFailure) return productErrorResponse(cause);
      console.error("Glass Cloud product boundary failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownFailure",
      });
      return json(productRequestUnavailable, 503);
    }
  });

export const handleRequest = (
  request: Request,
  bindings?: GlassApiBindingInput,
  createRuntime: GlassAuthRuntimeFactory = createGlassAuthRuntime,
): Response | Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json(health);
  }

  const authRoute = isAuthRoute(url.pathname);
  const protectedRoute =
    url.pathname === "/v1/authenticated-proof" ||
    url.pathname === "/v1/organizations" ||
    url.pathname.startsWith("/v1/notes/") ||
    url.pathname.startsWith("/v1/sync/");
  if (authRoute || protectedRoute) {
    const resolved = resolveGlassAuthConfig(bindings);
    if (!resolved.ok) {
      return json(productUnavailable, 503);
    }
    if (authRoute) {
      return withAuthRuntime(resolved.config, createRuntime, (runtime) => runtime.handle(request));
    }
    return handleAuthenticatedRoute(request, resolved.config, createRuntime, url);
  }

  return json(notFound, 404);
};

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<GlassApiBindings>;
