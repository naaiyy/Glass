import type { TransportFailure } from "@glass/client-runtime/outbox";
import type { BoundaryError, BoundaryErrorCode } from "@glass/contracts/errors";
import type { CommandId, OrganizationId, UserId } from "@glass/contracts/ids";
import { decodeId } from "@glass/contracts/ids";
import {
  decodeOrganizationsPage,
  type ListOrganizationsRequest,
  type OrganizationsPage,
} from "@glass/contracts/organizations";
import {
  decodeNoteContentResponse,
  decodeSaveNoteContentResponse,
  type NoteContentResponse,
  type SaveNoteContentRequest,
} from "@glass/contracts/notes";
import type {
  PullEventsRequest,
  PullEventsResponse,
  PushCommandsRequest,
  PushCommandsResponse,
  SnapshotPageRequest,
} from "@glass/contracts/sync";
import {
  decodePullEventsResponse,
  decodePushCommandsResponse,
  decodeSnapshotPageResponse,
} from "@glass/contracts/sync";
import { decodeRecord } from "@glass/contracts/validation";
import { decodeInteger } from "@glass/contracts/validation";

export class ProductCloudRequestError extends Error {
  readonly boundary: BoundaryError;
  readonly status: number;

  constructor(status: number, boundary: BoundaryError) {
    super(boundary.message);
    this.name = "ProductCloudRequestError";
    this.boundary = boundary;
    this.status = status;
  }
}

export class ProductCloudProtocolError extends Error {
  readonly issues: unknown;

  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = "ProductCloudProtocolError";
    this.issues = issues;
  }
}

const boundaryCodes: readonly BoundaryErrorCode[] = [
  "CONFLICT",
  "CURSOR_EXPIRED",
  "CURSOR_INVALID",
  "EXECUTION_UNAVAILABLE",
  "FORBIDDEN",
  "INVALID_RESPONSE",
  "NOT_FOUND",
  "PRODUCT_UNAVAILABLE",
  "UNAUTHENTICATED",
  "VALIDATION_FAILED",
];

const decodeBoundaryError = (input: unknown): BoundaryError => {
  const record = decodeRecord(input, "$error");
  if (!record.ok) {
    return {
      code: "INVALID_RESPONSE",
      message: "Glass Cloud returned an invalid error.",
      retryable: false,
    };
  }
  const code = boundaryCodes.find((candidate) => candidate === record.value.code);
  if (
    code === undefined ||
    typeof record.value.message !== "string" ||
    typeof record.value.retryable !== "boolean"
  ) {
    return {
      code: "INVALID_RESPONSE",
      message: "Glass Cloud returned an invalid error.",
      retryable: false,
    };
  }
  const commandId =
    record.value.commandId === undefined
      ? undefined
      : decodeId<CommandId>(record.value.commandId, "$error.commandId");
  const currentVersion =
    record.value.currentVersion === undefined
      ? undefined
      : decodeInteger(record.value.currentVersion, "$error.currentVersion", { min: 1 });
  if (commandId?.ok === false || currentVersion?.ok === false) {
    return {
      code: "INVALID_RESPONSE",
      message: "Glass Cloud returned an invalid error.",
      retryable: false,
    };
  }
  return {
    code,
    message: record.value.message,
    retryable: record.value.retryable,
    ...(commandId?.ok === true ? { commandId: commandId.value } : {}),
    ...(currentVersion?.ok === true ? { currentVersion: currentVersion.value } : {}),
  };
};

export const resolveApiUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined || baseUrl.trim() === "") return path;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ProductCloudProtocolError("VITE_GLASS_API_URL must be an absolute HTTP(S) URL.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new ProductCloudProtocolError("VITE_GLASS_API_URL must use HTTP or HTTPS.");
  }
  if (
    base.username.length > 0 ||
    base.password.length > 0 ||
    (base.pathname !== "" && base.pathname !== "/") ||
    base.search.length > 0 ||
    base.hash.length > 0
  ) {
    throw new ProductCloudProtocolError("VITE_GLASS_API_URL must contain only an HTTP(S) origin.");
  }
  return new URL(path, base.origin).toString();
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new ProductCloudProtocolError("Glass Cloud returned non-JSON data.", cause);
  }
};

const desktopProductFetch: typeof fetch = async (input, init) => {
  const bridge = window.glassDesktop;
  if (bridge === undefined) return fetch(input, init);
  const requestUrl =
    typeof input === "string"
      ? new URL(input, bridge.productCloudOrigin)
      : input instanceof URL
        ? input
        : new URL(input.url);
  if (requestUrl.origin !== bridge.productCloudOrigin) {
    throw new ProductCloudProtocolError("The desktop product request targeted another origin.");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    throw new ProductCloudProtocolError("The desktop product request used an unsupported method.");
  }
  if (init?.body !== undefined && typeof init.body !== "string") {
    throw new ProductCloudProtocolError("The desktop product request body must be JSON text.");
  }
  const response = await bridge.requestProduct({
    body: init?.body ?? null,
    method,
    path: `${requestUrl.pathname}${requestUrl.search}`,
  });
  return new Response(response.body, {
    headers: { "content-type": response.contentType },
    status: response.status,
  });
};

const runtimeProductFetch = (): typeof fetch =>
  typeof window !== "undefined" && window.glassDesktop !== undefined ? desktopProductFetch : fetch;

const authenticatedJson = async (
  fetcher: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await fetcher(url, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  const body = await readJson(response);
  if (!response.ok) throw new ProductCloudRequestError(response.status, decodeBoundaryError(body));
  return body;
};

export type AuthenticatedProductSession = Readonly<{ userId: UserId }>;

export const createProductCloudTransport = (
  baseUrl: string | undefined,
  fetcher: typeof fetch = runtimeProductFetch(),
) => {
  const endpoint = (path: string) => resolveApiUrl(baseUrl, path);

  const session = async (): Promise<AuthenticatedProductSession | null> => {
    try {
      const input = await authenticatedJson(fetcher, endpoint("/v1/authenticated-proof"));
      const record = decodeRecord(input, "$session");
      if (
        !record.ok ||
        record.value.authenticated !== true ||
        record.value.authority !== "glass-cloud"
      ) {
        throw new ProductCloudProtocolError("Glass Cloud returned an invalid session proof.");
      }
      const userId = decodeId<UserId>(record.value.userId, "$session.userId");
      if (!userId.ok)
        throw new ProductCloudProtocolError(
          "Glass Cloud returned an invalid user ID.",
          userId.issues,
        );
      return { userId: userId.value };
    } catch (error) {
      if (error instanceof ProductCloudRequestError && error.status === 401) return null;
      throw error;
    }
  };

  const snapshot = async (request: SnapshotPageRequest): Promise<unknown> => {
    const query = new URLSearchParams({
      limit: String(request.limit),
      organizationId: request.organizationId,
    });
    if (request.through !== null) query.set("through", request.through);
    if (request.after !== null) {
      query.set("afterSection", request.after.section);
      query.set("afterId", request.after.id);
      if (request.after.section === "message") {
        query.set("afterThreadId", request.after.threadId);
        query.set("afterOrdinal", request.after.ordinal);
      }
    }
    const input = await authenticatedJson(
      fetcher,
      endpoint(`/v1/sync/snapshot?${query.toString()}`),
    );
    const decoded = decodeSnapshotPageResponse(input, request);
    if (!decoded.ok)
      throw new ProductCloudProtocolError("Snapshot page failed validation.", decoded.issues);
    return decoded.value;
  };

  const listOrganizations = async (
    userId: UserId,
    request: ListOrganizationsRequest,
  ): Promise<OrganizationsPage> => {
    const query = new URLSearchParams({ limit: String(request.limit) });
    if (request.after !== null) query.set("after", request.after);
    const input = await authenticatedJson(
      fetcher,
      endpoint(`/v1/organizations?${query.toString()}`),
    );
    const decoded = decodeOrganizationsPage(input);
    if (!decoded.ok)
      throw new ProductCloudProtocolError("Organization page failed validation.", decoded.issues);
    if (decoded.value.items.some((item) => item.membership.userId !== userId)) {
      throw new ProductCloudProtocolError("Organization page contained another user's membership.");
    }
    return decoded.value;
  };

  const pull = async (request: PullEventsRequest): Promise<PullEventsResponse> => {
    const query = new URLSearchParams({
      organizationId: request.organizationId,
      limit: String(request.limit),
    });
    if (request.after !== null) query.set("after", request.after);
    if (request.through !== null) query.set("through", request.through);
    const input = await authenticatedJson(fetcher, endpoint(`/v1/sync/pull?${query.toString()}`));
    const decoded = decodePullEventsResponse(input);
    if (!decoded.ok)
      throw new ProductCloudProtocolError("Pull response failed validation.", decoded.issues);
    if (
      decoded.value.head.organizationId !== request.organizationId ||
      decoded.value.events.some((event) => event.organizationId !== request.organizationId)
    ) {
      throw new ProductCloudProtocolError("Pull response crossed organization scope.");
    }
    return decoded.value;
  };

  const push = async (request: PushCommandsRequest): Promise<PushCommandsResponse> => {
    const input = await authenticatedJson(fetcher, endpoint("/v1/sync/push"), {
      body: JSON.stringify(request),
      method: "POST",
    });
    const decoded = decodePushCommandsResponse(input);
    if (!decoded.ok)
      throw new ProductCloudProtocolError("Push response failed validation.", decoded.issues);
    if (
      decoded.value.results.length !== request.commands.length ||
      decoded.value.results.some(
        (result, index) => result.commandId !== request.commands[index]?.commandId,
      )
    ) {
      throw new ProductCloudProtocolError("Push response did not match the submitted commands.");
    }
    return decoded.value;
  };

  const loadNoteContent = async (
    organizationId: OrganizationId,
    noteId: SaveNoteContentRequest["noteId"],
  ): Promise<NoteContentResponse> => {
    const query = new URLSearchParams({ organizationId, noteId });
    const input = await authenticatedJson(
      fetcher,
      endpoint(`/v1/notes/content?${query.toString()}`),
    );
    const decoded = decodeNoteContentResponse(input);
    if (!decoded.ok)
      throw new ProductCloudProtocolError(
        "Note content response failed validation.",
        decoded.issues,
      );
    if (decoded.value.organizationId !== organizationId || decoded.value.noteId !== noteId) {
      throw new ProductCloudProtocolError("Note content response crossed its requested scope.");
    }
    return decoded.value;
  };

  const saveNoteContent = async (request: SaveNoteContentRequest): Promise<void> => {
    const input = await authenticatedJson(fetcher, endpoint("/v1/notes/content"), {
      body: JSON.stringify(request),
      method: "PUT",
    });
    const decoded = decodeSaveNoteContentResponse(input);
    if (!decoded.ok)
      throw new ProductCloudProtocolError("Save note response failed validation.", decoded.issues);
    if (
      decoded.value.organizationId !== request.organizationId ||
      decoded.value.noteId !== request.noteId
    ) {
      throw new ProductCloudProtocolError("Save note response crossed its requested scope.");
    }
  };

  return { listOrganizations, loadNoteContent, pull, push, saveNoteContent, session, snapshot };
};

export const classifyProductTransportError = (error: unknown): TransportFailure => {
  if (error instanceof ProductCloudRequestError) {
    if (error.boundary.retryable || error.status >= 500) return { kind: "transient" };
    const code =
      error.boundary.code === "UNAUTHENTICATED"
        ? "unauthenticated"
        : error.boundary.code === "CONFLICT"
          ? "conflict"
          : error.boundary.code === "NOT_FOUND"
            ? "not-found"
            : error.boundary.code === "VALIDATION_FAILED" ||
                error.boundary.code === "INVALID_RESPONSE"
              ? "invalid"
              : "forbidden";
    return {
      code,
      currentVersion: error.boundary.currentVersion ?? null,
      kind: "permanent",
      message: error.message,
    };
  }
  return error instanceof ProductCloudProtocolError
    ? {
        code: "invalid",
        currentVersion: null,
        kind: "permanent",
        message: error.message,
      }
    : { kind: "transient" };
};

export const drainThenSynchronize = async (
  drain: () => Promise<void>,
  synchronize: () => Promise<void>,
): Promise<void> => {
  await drain();
  await synchronize();
};

export const requiresProductResnapshot = (error: unknown): boolean =>
  error instanceof ProductCloudRequestError &&
  (error.boundary.code === "CURSOR_EXPIRED" || error.boundary.code === "CURSOR_INVALID");

export const synchronizeFromCheckpoint = async (
  input: Readonly<{
    drain: () => Promise<void>;
    hasCachedSnapshot: boolean;
    installSnapshot: () => Promise<void>;
    synchronize: () => Promise<void>;
  }>,
): Promise<void> => {
  try {
    await input.drain();
    if (!input.hasCachedSnapshot) await input.installSnapshot();
    await input.synchronize();
  } catch (error) {
    if (!requiresProductResnapshot(error)) throw error;
    await input.installSnapshot();
    await input.synchronize();
  }
};
