import { glassProtocolVersion, type HealthDescriptor } from "@glass/contracts/architecture";
import type { BoundaryError } from "@glass/contracts/errors";
import {
  decodePublishNodePresenceRequest,
  decodeRecordOperationFrameRequest,
  decodeTunnelConfigurationRequest,
  decodeValidateClientTicketRequest,
  decodeValidateDispatchRequest,
  maxTunnelControlBodyBytes,
  type TunnelEnvironmentProof,
} from "@glass/contracts/connect-tunnel";
import {
  decodeApproveEnvironmentPairingRequest,
  decodeBeginEnvironmentPairingRequest,
  decodeCompleteEnvironmentProofRequest,
  decodeCreateCredentialChallengeRequest,
  decodeEnvironmentPairingStatusRequest,
} from "@glass/contracts/environments";
import { environmentCredentialScope } from "@glass/contracts/environments";
import {
  decodeCreateExecutionOperationRequest,
  decodeCreateWorkspaceBindingRequest,
  decodeExecutionEventsQuery,
  type ExecutionDispatch,
  type ExecutionOperation,
} from "@glass/contracts/execution-cloud";
import { decodeId, type ExecutionEnvironmentId, type OrganizationId } from "@glass/contracts/ids";
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
  hasGlassConnectBindings,
  resolveGlassAuthConfig,
  type GlassApiBindingInput,
  type GlassApiBindings,
  type GlassAuthConfig,
} from "./env.ts";
import { ProductFailure } from "./product-service.ts";
import { EnvironmentFailure } from "./environment-service.ts";
import {
  digestConnectDispatchPayload,
  dispatchFrameMatchesGrant,
  hasValidConnectTicketSecret,
  issueConnectDispatchGrant,
  verifyConnectDispatchGrant,
} from "./connect-tickets.ts";
import { ExecutionServiceFailure } from "./execution-service.ts";
import { TunnelServiceFailure } from "./tunnel-service.ts";
import type { VerifiedEnvironmentCredential } from "./environment-service.ts";
export { GlassConnectAuthority } from "./connect-authority.ts";

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

const trustRequestRateLimited: BoundaryError = {
  code: "CONFLICT",
  message: "Too many environment trust requests were received. Try again shortly.",
  retryable: true,
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const trustPollingRoutes = new Set(["/v1/environment-pairings/status"]);

const enforceTrustRateLimit = async (
  request: Request,
  url: URL,
  bindings: GlassApiBindingInput | undefined,
): Promise<Response | null> => {
  const polling = trustPollingRoutes.has(url.pathname);
  const limiter = polling ? bindings?.TRUST_POLL_RATE_LIMIT : bindings?.TRUST_MUTATION_RATE_LIMIT;
  if (limiter === undefined) return json(productUnavailable, 503);
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  let result: Awaited<ReturnType<RateLimit["limit"]>>;
  try {
    result = await limiter.limit({ key: `${url.hostname}:${clientAddress}` });
  } catch (cause) {
    console.error("Environment trust rate-limit binding failed.", {
      errorType: cause instanceof Error ? cause.name : "UnknownFailure",
      bucket: polling ? "poll" : "mutation",
    });
    return json(productUnavailable, 503);
  }
  return result.success
    ? null
    : Response.json(trustRequestRateLimited, {
        status: 429,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
};

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

const environmentErrorResponse = (cause: unknown): Response => {
  if (!(cause instanceof EnvironmentFailure)) throw cause;
  const statusByCode = { conflict: 409, forbidden: 403, invalid: 422, "not-found": 404 } as const;
  const codeByFailure = {
    conflict: "CONFLICT",
    forbidden: "FORBIDDEN",
    invalid: "VALIDATION_FAILED",
    "not-found": "NOT_FOUND",
  } as const;
  return json(
    { code: codeByFailure[cause.code], message: cause.message, retryable: cause.retryable },
    statusByCode[cause.code],
  );
};

const executionErrorResponse = (cause: unknown): Response => {
  if (!(cause instanceof ExecutionServiceFailure)) throw cause;
  const status =
    cause.code === "forbidden"
      ? 403
      : cause.code === "not-found"
        ? 404
        : cause.code === "conflict"
          ? 409
          : 422;
  const code =
    cause.code === "forbidden"
      ? "FORBIDDEN"
      : cause.code === "not-found"
        ? "NOT_FOUND"
        : cause.code === "conflict"
          ? "CONFLICT"
          : "VALIDATION_FAILED";
  return json({ code, message: cause.message, retryable: cause.retryable }, status);
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

const readDecodedBody = async <Value>(
  request: Request,
  decode: (
    input: unknown,
  ) => { ok: true; value: Value } | { ok: false; issues: readonly unknown[] },
  maxBytes = 16_384,
): Promise<Value | Response> => {
  const decoded = decode(
    await readJsonBody(request, maxBytes, "The environment request body is too large."),
  );
  return decoded.ok ? decoded.value : json({ ...invalidRequest, issues: decoded.issues }, 422);
};

const verifyTunnelEnvironmentProof = async (
  request: Request,
  proof: TunnelEnvironmentProof,
  runtime: GlassAuthRuntime,
  bindings: GlassApiBindingInput | undefined,
): Promise<VerifiedEnvironmentCredential | null> => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? null;
  if (
    token === null ||
    bindings?.CONNECT_AUTHORITY === undefined ||
    runtime.environment === undefined
  )
    return null;
  const challenge = await bindings.CONNECT_AUTHORITY.getByName(
    proof.environmentId,
  ).consumeNodeProofChallenge(proof.proofChallengeId);
  if (challenge === null) return null;
  const credential = await runtime.environment.verifyCredentialProof(
    token,
    environmentCredentialScope,
    challenge,
    proof.signature,
  );
  const verified =
    credential !== null &&
    credential.environmentId === proof.environmentId &&
    credential.organizationId === proof.organizationId
      ? credential
      : null;
  if (verified === null) return null;
  const limiter = bindings.CONNECT_NODE_RATE_LIMIT;
  if (limiter === undefined)
    throw new TunnelServiceFailure("unavailable", "The node control limiter is unavailable.");
  const limited = await limiter.limit({
    key: `${verified.environmentId}:${verified.credentialId}`,
  });
  if (!limited.success)
    throw new TunnelServiceFailure("rate-limited", "Too many node control requests were received.");
  return verified;
};

const handlePublicEnvironmentRoute = async (
  request: Request,
  url: URL,
  runtime: GlassAuthRuntime,
  bindings?: GlassApiBindingInput,
): Promise<Response> => {
  const service = runtime.environment;
  if (service === undefined) return json(productUnavailable, 503);
  try {
    if (request.method === "POST" && url.pathname === "/v1/connect/tunnel-configuration") {
      const body = await readDecodedBody(request, decodeTunnelConfigurationRequest);
      if (body instanceof Response || runtime.tunnel === undefined)
        return body instanceof Response ? body : json(productUnavailable, 503);
      const credential = await verifyTunnelEnvironmentProof(request, body, runtime, bindings);
      return credential === null
        ? json(unauthorized, 401)
        : json(
            await runtime.tunnel.configure({
              environmentId: credential.environmentId,
              organizationId: credential.organizationId,
              localOrigin: body.localOrigin,
            }),
            201,
          );
    }
    if (request.method === "POST" && url.pathname === "/v1/connect/validate-client-ticket") {
      const body = await readDecodedBody(request, decodeValidateClientTicketRequest);
      if (body instanceof Response || runtime.tunnel === undefined)
        return body instanceof Response ? body : json(productUnavailable, 503);
      const credential = await verifyTunnelEnvironmentProof(request, body, runtime, bindings);
      if (credential === null) return json(unauthorized, 401);
      const validation = await runtime.tunnel.consumeClientTicket(
        body.ticket,
        credential.environmentId,
        credential.organizationId,
      );
      return validation === null ? json(unauthorized, 401) : json(validation);
    }
    if (request.method === "POST" && url.pathname === "/v1/connect/validate-dispatch") {
      const body = await readDecodedBody(
        request,
        decodeValidateDispatchRequest,
        maxTunnelControlBodyBytes,
      );
      if (
        body instanceof Response ||
        runtime.tunnel === undefined ||
        runtime.execution === undefined
      )
        return body instanceof Response ? body : json(productUnavailable, 503);
      const credential = await verifyTunnelEnvironmentProof(request, body, runtime, bindings);
      if (credential === null) return json(unauthorized, 401);
      const session = await runtime.tunnel.activeSession(
        body.sessionId,
        credential.environmentId,
        credential.organizationId,
      );
      const grant = await verifyConnectDispatchGrant(
        body.frame.dispatchGrant,
        bindings?.CONNECT_TICKET_SECRET ?? "",
      );
      if (
        session === null ||
        grant === null ||
        grant.environmentId !== credential.environmentId ||
        grant.organizationId !== credential.organizationId ||
        !(await dispatchFrameMatchesGrant(body.frame, grant)) ||
        !(await runtime.execution.claimDispatch(
          grant,
          session.actorUserId,
          body.sessionId,
          session.channelId,
        ))
      )
        return json(unauthorized, 401);
      return json({ sessionId: body.sessionId });
    }
    if (request.method === "POST" && url.pathname === "/v1/connect/operation-events") {
      const body = await readDecodedBody(
        request,
        decodeRecordOperationFrameRequest,
        maxTunnelControlBodyBytes,
      );
      if (
        body instanceof Response ||
        runtime.tunnel === undefined ||
        runtime.execution === undefined
      )
        return body instanceof Response ? body : json(productUnavailable, 503);
      const credential = await verifyTunnelEnvironmentProof(request, body, runtime, bindings);
      if (credential === null) return json(unauthorized, 401);
      const session = await runtime.tunnel.claimedSession(
        body.sessionId,
        credential.environmentId,
        credential.organizationId,
      );
      if (session === null) return json(unauthorized, 401);
      await runtime.execution.recordClaimedNodeFrame(body.sessionId, session.channelId, body.frame);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/v1/connect/node-presence") {
      const body = await readDecodedBody(request, decodePublishNodePresenceRequest);
      if (body instanceof Response || runtime.tunnel === undefined)
        return body instanceof Response ? body : json(productUnavailable, 503);
      const credential = await verifyTunnelEnvironmentProof(request, body, runtime, bindings);
      if (credential === null) return json(unauthorized, 401);
      await runtime.tunnel.publishPresence(body);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/v1/environment-pairings") {
      const body = await readDecodedBody(request, decodeBeginEnvironmentPairingRequest);
      return body instanceof Response ? body : json(await service.beginPairing(body), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/environment-pairings/status") {
      const body = await readDecodedBody(request, decodeEnvironmentPairingStatusRequest);
      return body instanceof Response ? body : json(await service.pairingStatus(body));
    }
    if (request.method === "POST" && url.pathname === "/v1/environment-pairings/complete") {
      const body = await readDecodedBody(request, decodeCompleteEnvironmentProofRequest);
      return body instanceof Response ? body : json(await service.completePairing(body), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/environment-credentials/challenges") {
      const body = await readDecodedBody(request, decodeCreateCredentialChallengeRequest);
      return body instanceof Response
        ? body
        : json(await service.createCredentialChallenge(body), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/environment-credentials/exchange") {
      const body = await readDecodedBody(request, decodeCompleteEnvironmentProofRequest);
      return body instanceof Response ? body : json(await service.exchangeCredential(body), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/connect/node-challenges") {
      const body = await readJsonBody(request, 4_096);
      if (
        typeof body !== "object" ||
        body === null ||
        !("environmentId" in body) ||
        !("organizationId" in body) ||
        bindings?.CONNECT_AUTHORITY === undefined
      )
        return json(invalidRequest, 422);
      const environmentId = decodeId<ExecutionEnvironmentId>(body.environmentId, "$.environmentId");
      const organizationId = decodeId<OrganizationId>(body.organizationId, "$.organizationId");
      if (!environmentId.ok || !organizationId.ok) return json(invalidRequest, 422);
      const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? null;
      const credential =
        token === null
          ? null
          : await service.authenticateCredential(token, environmentCredentialScope);
      if (
        credential === null ||
        credential.environmentId !== environmentId.value ||
        credential.organizationId !== organizationId.value
      )
        return json(unauthorized, 401);
      const limiter = bindings.CONNECT_NODE_RATE_LIMIT;
      if (limiter === undefined) return json(productUnavailable, 503);
      const limit = await limiter.limit({
        key: `${credential.environmentId}:${credential.credentialId}`,
      });
      if (!limit.success)
        return Response.json(trustRequestRateLimited, {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        });
      if (!(await service.hasActiveEnvironment(organizationId.value, environmentId.value))) {
        return json(
          {
            code: "NOT_FOUND",
            message: "The execution environment does not exist.",
            retryable: false,
          },
          404,
        );
      }
      const challenge = await bindings.CONNECT_AUTHORITY.getByName(
        environmentId.value,
      ).issueNodeProofChallenge(environmentId.value, organizationId.value);
      return challenge === null
        ? json(
            {
              code: "CONFLICT",
              message: "Too many Glass Connect challenges are active.",
              retryable: true,
            },
            429,
          )
        : json(challenge, 201);
    }
    return json(notFound, 404);
  } catch (cause) {
    if (cause instanceof EnvironmentFailure) return environmentErrorResponse(cause);
    if (cause instanceof TunnelServiceFailure) {
      const status =
        cause.code === "rate-limited"
          ? 429
          : cause.code === "forbidden"
            ? 403
            : cause.code === "not-found"
              ? 404
              : cause.code === "conflict"
                ? 409
                : 503;
      return json(
        {
          code:
            cause.code === "rate-limited"
              ? "CONFLICT"
              : cause.code === "forbidden"
                ? "FORBIDDEN"
                : cause.code === "not-found"
                  ? "NOT_FOUND"
                  : cause.code === "conflict"
                    ? "CONFLICT"
                    : "PRODUCT_UNAVAILABLE",
          message: cause.message,
          retryable: cause.code === "unavailable" || cause.code === "rate-limited",
        },
        status,
      );
    }
    throw cause;
  }
};

const handleAuthenticatedEnvironmentRoute = async (
  request: Request,
  url: URL,
  runtime: GlassAuthRuntime,
  userId: string,
  bindings?: GlassApiBindingInput,
): Promise<Response> => {
  const service = runtime.environment;
  if (service === undefined) return json(productUnavailable, 503);
  try {
    if (request.method === "POST" && url.pathname === "/v1/environment-pairings/approve") {
      const body = await readDecodedBody(request, decodeApproveEnvironmentPairingRequest);
      if (body instanceof Response) return body;
      await service.approvePairing(userId, body);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/v1/environments") {
      if (
        [...url.searchParams.keys()].some((key) => key !== "organizationId") ||
        url.searchParams.getAll("organizationId").length !== 1
      )
        return json(invalidRequest, 422);
      const organizationId = decodeId<OrganizationId>(
        url.searchParams.get("organizationId"),
        "$environments.organizationId",
      );
      return organizationId.ok
        ? json(await service.list(userId, organizationId.value))
        : json({ ...invalidRequest, issues: organizationId.issues }, 422);
    }
    const presenceMatch = /^\/v1\/environments\/([^/]+)\/presence$/u.exec(url.pathname);
    if (request.method === "GET" && presenceMatch !== null) {
      const environmentId = decodeId<ExecutionEnvironmentId>(presenceMatch[1], "$.environmentId");
      const organizationId = decodeId<OrganizationId>(
        url.searchParams.get("organizationId"),
        "$.organizationId",
      );
      if (!environmentId.ok || !organizationId.ok || runtime.tunnel === undefined)
        return json(invalidRequest, 422);
      const environment = await service.authorizeUserEnvironment(
        userId,
        organizationId.value,
        environmentId.value,
      );
      if (environment === null)
        return json(
          {
            code: "FORBIDDEN",
            message: "The execution environment is not available.",
            retryable: false,
          },
          403,
        );
      return json(await runtime.tunnel.presence(environmentId.value));
    }
    const catalogMatch = /^\/v1\/environments\/([^/]+)\/workspace-catalog$/u.exec(url.pathname);
    if (request.method === "GET" && catalogMatch !== null) {
      const environmentId = decodeId<ExecutionEnvironmentId>(catalogMatch[1], "$.environmentId");
      const organizationId = decodeId<OrganizationId>(
        url.searchParams.get("organizationId"),
        "$.organizationId",
      );
      if (
        !environmentId.ok ||
        !organizationId.ok ||
        runtime.tunnel === undefined ||
        runtime.execution === undefined
      )
        return json(invalidRequest, 422);
      if (
        !(await runtime.execution.authorizeEnvironmentAdmin(
          userId,
          organizationId.value,
          environmentId.value,
        ))
      ) {
        return json(
          {
            code: "FORBIDDEN",
            message: "Only organization administrators can discover unbound workspaces.",
            retryable: false,
          },
          403,
        );
      }
      return json(await runtime.tunnel.workspaceCatalog(environmentId.value));
    }
    const connectTicketMatch = /^\/v1\/environments\/([^/]+)\/connect-ticket$/u.exec(url.pathname);
    if (request.method === "POST" && connectTicketMatch !== null) {
      if (runtime.tunnel === undefined) return json(productUnavailable, 503);
      const environmentId = decodeId<ExecutionEnvironmentId>(
        connectTicketMatch[1],
        "$.environmentId",
      );
      const body = await readJsonBody(request, 4_096);
      const organizationId =
        typeof body === "object" && body !== null && "organizationId" in body
          ? decodeId<OrganizationId>(body.organizationId, "$.organizationId")
          : null;
      const clientNonce =
        typeof body === "object" && body !== null && "clientNonce" in body
          ? body.clientNonce
          : null;
      if (
        !environmentId.ok ||
        organizationId === null ||
        !organizationId.ok ||
        typeof clientNonce !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(clientNonce)
      )
        return json(invalidRequest, 422);
      const environment = await service.authorizeUserEnvironment(
        userId,
        organizationId.value,
        environmentId.value,
      );
      if (environment === null)
        return json(
          {
            code: "FORBIDDEN",
            message: "The execution environment is not available.",
            retryable: false,
          },
          403,
        );
      const ticket = await runtime.tunnel.issueClientTicket(
        userId,
        environment.id,
        environment.organizationId,
        clientNonce,
      );
      return json(
        {
          expiresAt: ticket.expiresAt,
          keyVersion: ticket.keyVersion,
          publicKey: ticket.publicKey,
          ticket: ticket.ticket,
          ticketId: ticket.ticketId,
          websocketUrl: ticket.websocketUrl,
        },
        201,
      );
    }
    const match = /^\/v1\/environments\/([^/]+)$/u.exec(url.pathname);
    if (match !== null) {
      const environmentId = decodeId<ExecutionEnvironmentId>(match[1], "$environmentId");
      if (!environmentId.ok) return json({ ...invalidRequest, issues: environmentId.issues }, 422);
      if (request.method === "DELETE") {
        const environment = await service.revoke(userId, environmentId.value);
        const authority = bindings?.CONNECT_AUTHORITY?.getByName(environmentId.value);
        try {
          await runtime.execution?.invalidateEnvironment(environmentId.value);
        } finally {
          try {
            await authority?.revoke();
          } finally {
            await runtime.tunnel?.revoke(environmentId.value);
          }
        }
        return json(environment);
      }
    }
    return json(notFound, 404);
  } catch (cause) {
    if (cause instanceof EnvironmentFailure) return environmentErrorResponse(cause);
    throw cause;
  }
};

const dispatchForOperation = async (
  operation: ExecutionOperation,
  secret: string,
  purpose: "cancel" | "request" = "request",
): Promise<ExecutionDispatch> => ({
  operation,
  dispatchGrant: await issueConnectDispatchGrant(
    {
      capability: operation.request.operation,
      environmentId: operation.environmentId,
      expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
      intentId: operation.operationId,
      operationId: operation.operationId,
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      purpose,
      requestId: operation.requestId,
      requestDigest: await digestConnectDispatchPayload(operation.request),
      workspaceId: operation.workspaceId,
    },
    secret,
  ),
});

export const canIssueRequestDispatch = (operation: ExecutionOperation): boolean =>
  operation.status === "queued";

const handleAuthenticatedExecutionRoute = async (
  request: Request,
  url: URL,
  runtime: GlassAuthRuntime,
  userId: string,
  bindings?: GlassApiBindingInput,
): Promise<Response> => {
  const service = runtime.execution;
  if (service === undefined || !hasValidConnectTicketSecret(bindings?.CONNECT_TICKET_SECRET)) {
    return json(productUnavailable, 503);
  }
  try {
    if (request.method === "GET" && url.pathname === "/v1/workspace-bindings") {
      const organizationId = decodeId<OrganizationId>(
        url.searchParams.get("organizationId"),
        "$.organizationId",
      );
      const projectId = decodeId<string>(url.searchParams.get("projectId"), "$.projectId");
      return organizationId.ok && projectId.ok
        ? json(await service.listWorkspaceBindings(userId, organizationId.value, projectId.value))
        : json(invalidRequest, 422);
    }
    if (request.method === "POST" && url.pathname === "/v1/workspace-bindings") {
      const body = await readDecodedBody(request, decodeCreateWorkspaceBindingRequest);
      if (body instanceof Response) return body;
      if (
        runtime.tunnel === undefined ||
        !(await service.authorizeEnvironmentAdmin(userId, body.organizationId, body.environmentId))
      ) {
        return json(
          {
            code: "FORBIDDEN",
            message: "Only organization administrators can bind advertised workspaces.",
            retryable: false,
          },
          403,
        );
      }
      const workspace = (await runtime.tunnel.workspaceCatalog(body.environmentId)).find(
        (candidate) => candidate.id === body.workspaceId,
      );
      if (workspace === undefined) {
        return json(
          {
            code: "VALIDATION_FAILED",
            message: "The workspace is not advertised by the authenticated execution node.",
            retryable: false,
          },
          422,
        );
      }
      return json(await service.createWorkspaceBinding(userId, body, workspace.name), 201);
    }
    const bindingMatch = /^\/v1\/workspace-bindings\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "DELETE" && bindingMatch !== null) {
      return json(
        await service.revokeWorkspaceBinding(userId, bindingMatch[1] ?? "", bindingMatch[2] ?? ""),
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/execution-operations") {
      const body = await readDecodedBody(request, decodeCreateExecutionOperationRequest);
      if (body instanceof Response) return body;
      return json(
        await dispatchForOperation(
          await service.createOperation(userId, body),
          bindings.CONNECT_TICKET_SECRET,
        ),
        201,
      );
    }
    const operationMatch = /^\/v1\/execution-operations\/([^/]+)(?:\/(cancel|dispatch))?$/u.exec(
      url.pathname,
    );
    if (operationMatch !== null) {
      const operationId = operationMatch[1] ?? "";
      if (request.method === "GET" && operationMatch[2] === undefined) {
        const query = decodeExecutionEventsQuery({
          after: Number(url.searchParams.get("after") ?? -1),
          limit: Number(url.searchParams.get("limit") ?? 100),
        });
        return query.ok
          ? json(
              await service.getOperation(userId, operationId, query.value.after, query.value.limit),
            )
          : json({ ...invalidRequest, issues: query.issues }, 422);
      }
      if (request.method === "POST" && operationMatch[2] === "dispatch") {
        const operation = await service.getOperation(userId, operationId, -1, 1);
        if (!canIssueRequestDispatch(operation)) return json(operation);
        return json(await dispatchForOperation(operation, bindings.CONNECT_TICKET_SECRET));
      }
      if (request.method === "POST" && operationMatch[2] === "cancel") {
        const operation = await service.cancelOperation(userId, operationId);
        return ["succeeded", "failed", "cancelled"].includes(operation.status)
          ? json({ operation, dispatchGrant: null })
          : json(await dispatchForOperation(operation, bindings.CONNECT_TICKET_SECRET, "cancel"));
      }
    }
    return json(notFound, 404);
  } catch (cause) {
    if (cause instanceof ExecutionServiceFailure) return executionErrorResponse(cause);
    throw cause;
  }
};

const withAuthRuntime = async (
  config: GlassAuthConfig,
  createRuntime: GlassAuthRuntimeFactory,
  useRuntime: (runtime: GlassAuthRuntime) => Promise<Response>,
  bindings?: GlassApiBindingInput,
): Promise<Response> => {
  let runtime: GlassAuthRuntime;
  try {
    runtime = await createRuntime(config, bindings);
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
  bindings?: GlassApiBindingInput,
): Promise<Response> =>
  withAuthRuntime(
    config,
    createRuntime,
    async (runtime) => {
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
        if (
          url.pathname === "/v1/workspace-bindings" ||
          url.pathname.startsWith("/v1/workspace-bindings/") ||
          url.pathname === "/v1/execution-operations" ||
          url.pathname.startsWith("/v1/execution-operations/")
        ) {
          return await handleAuthenticatedExecutionRoute(
            request,
            url,
            runtime,
            session.user.id,
            bindings,
          );
        }
        if (
          url.pathname === "/v1/environments" ||
          url.pathname.startsWith("/v1/environments/") ||
          url.pathname === "/v1/environment-pairings/approve"
        ) {
          return await handleAuthenticatedEnvironmentRoute(
            request,
            url,
            runtime,
            session.user.id,
            bindings,
          );
        }
        return await handleProductRoute(request, url, runtime, session.user.id);
      } catch (cause) {
        if (cause instanceof ProductFailure) return productErrorResponse(cause);
        console.error("Glass Cloud product boundary failed.", {
          errorType: cause instanceof Error ? cause.name : "UnknownFailure",
        });
        return json(productRequestUnavailable, 503);
      }
    },
    bindings,
  );

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
  const publicEnvironmentRoute =
    url.pathname === "/v1/environment-pairings" ||
    url.pathname === "/v1/environment-pairings/status" ||
    url.pathname === "/v1/environment-pairings/complete" ||
    url.pathname.startsWith("/v1/environment-credentials/") ||
    url.pathname === "/v1/connect/node-challenges" ||
    url.pathname === "/v1/connect/tunnel-configuration" ||
    url.pathname === "/v1/connect/validate-client-ticket" ||
    url.pathname === "/v1/connect/validate-dispatch" ||
    url.pathname === "/v1/connect/operation-events" ||
    url.pathname === "/v1/connect/node-presence";
  const protectedRoute =
    url.pathname === "/v1/authenticated-proof" ||
    url.pathname === "/v1/organizations" ||
    url.pathname.startsWith("/v1/notes/") ||
    url.pathname.startsWith("/v1/sync/") ||
    url.pathname === "/v1/environment-pairings/approve" ||
    url.pathname === "/v1/environments" ||
    url.pathname.startsWith("/v1/environments/");
  const executionRoute =
    url.pathname === "/v1/workspace-bindings" ||
    url.pathname.startsWith("/v1/workspace-bindings/") ||
    url.pathname === "/v1/execution-operations" ||
    url.pathname.startsWith("/v1/execution-operations/");
  if (authRoute || protectedRoute || publicEnvironmentRoute || executionRoute) {
    const resolved = resolveGlassAuthConfig(bindings);
    if (!resolved.ok) {
      return json(productUnavailable, 503);
    }
    if (authRoute) {
      return withAuthRuntime(
        resolved.config,
        createRuntime,
        (runtime) => runtime.handle(request),
        bindings,
      );
    }
    if (publicEnvironmentRoute) {
      if (url.pathname.startsWith("/v1/connect/") && !hasGlassConnectBindings(bindings))
        return json(productUnavailable, 503);
      const rateLimit = url.pathname.startsWith("/v1/connect/")
        ? Promise.resolve(null)
        : enforceTrustRateLimit(request, url, bindings);
      return rateLimit.then((limited) =>
        limited === null
          ? withAuthRuntime(
              resolved.config,
              createRuntime,
              (runtime) => handlePublicEnvironmentRoute(request, url, runtime, bindings),
              bindings,
            )
          : limited,
      );
    }
    if (executionRoute && !hasGlassConnectBindings(bindings)) return json(productUnavailable, 503);
    return handleAuthenticatedRoute(request, resolved.config, createRuntime, url, bindings);
  }

  return json(notFound, 404);
};

export default {
  fetch: (request, env) => handleRequest(request, env),
  scheduled: async (_controller, env) => {
    const resolved = resolveGlassAuthConfig(env);
    if (!resolved.ok) return;
    let runtime: GlassAuthRuntime | undefined;
    try {
      runtime = await createGlassAuthRuntime(resolved.config, env);
      await runtime.tunnel?.reconcilePending();
    } catch (cause) {
      console.error("Glass Connect reconciliation failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownFailure",
      });
    } finally {
      await runtime?.close();
    }
  },
} satisfies ExportedHandler<GlassApiBindings>;
