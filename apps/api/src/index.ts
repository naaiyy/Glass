import { glassProtocolVersion, type HealthDescriptor } from "@glass/contracts/architecture";
import type { BoundaryError } from "@glass/contracts/errors";

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

const health: HealthDescriptor = {
  service: "glass-api",
  status: "ok",
  architecture: {
    kind: "glass-cloud",
    protocolVersion: glassProtocolVersion,
    status: "foundation",
  },
};

const notFound: BoundaryError = {
  code: "INVALID_RESPONSE",
  message: "The requested API foundation route does not exist.",
  retryable: false,
};

const productUnavailable: BoundaryError = {
  code: "PRODUCT_UNAVAILABLE",
  message:
    "Glass Cloud authentication is unavailable because its durable runtime is not configured.",
  retryable: true,
};

const unauthorized: BoundaryError = {
  code: "UNAUTHENTICATED",
  message: "A valid Glass Cloud session is required.",
  retryable: false,
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const isAuthRoute = (pathname: string): boolean =>
  pathname === "/api/auth" || pathname.startsWith("/api/auth/");

const withAuthRuntime = async (
  config: GlassAuthConfig,
  createRuntime: GlassAuthRuntimeFactory,
  useRuntime: (runtime: GlassAuthRuntime) => Promise<Response>,
): Promise<Response> => {
  let runtime: GlassAuthRuntime | undefined;
  try {
    runtime = await createRuntime(config);
    return await useRuntime(runtime);
  } catch {
    return json(productUnavailable, 503);
  } finally {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        // The response is already determined; a failed connection close must not replace it.
      }
    }
  }
};

const handleAuthenticatedRoute = (
  request: Request,
  config: GlassAuthConfig,
  createRuntime: GlassAuthRuntimeFactory,
): Promise<Response> =>
  withAuthRuntime(config, createRuntime, async (runtime) => {
    const session = await runtime.getSession(request.headers);
    if (!session) {
      return json(unauthorized, 401);
    }
    return json({
      authenticated: true,
      authority: "glass-cloud",
      userId: session.user.id,
    });
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
  const protectedRoute = request.method === "GET" && url.pathname === "/v1/authenticated-proof";
  if (authRoute || protectedRoute) {
    const resolved = resolveGlassAuthConfig(bindings);
    if (!resolved.ok) {
      return json(productUnavailable, 503);
    }
    if (authRoute) {
      return withAuthRuntime(resolved.config, createRuntime, (runtime) => runtime.handle(request));
    }
    return handleAuthenticatedRoute(request, resolved.config, createRuntime);
  }

  return json(notFound, 404);
};

export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<GlassApiBindings>;
