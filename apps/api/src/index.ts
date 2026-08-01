import { glassProtocolVersion, type HealthDescriptor } from "@glass/contracts/architecture";
import type { BoundaryError } from "@glass/contracts/errors";

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

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const handleRequest = (request: Request): Response => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json(health);
  }

  return json(notFound, 404);
};

export default {
  fetch: handleRequest,
} satisfies ExportedHandler;
