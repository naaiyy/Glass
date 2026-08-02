import type { OutboxTransport, TransportFailure } from "@glass/client-runtime/outbox";
import type { SyncTransport } from "@glass/client-runtime/sync";
import type { BoundaryError, BoundaryErrorCode } from "@glass/contracts/errors";
import { decodeId, type CommandId, type OrganizationId, type UserId } from "@glass/contracts/ids";
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
import {
  decodePullEventsResponse,
  decodePushCommandsResponse,
  type PullEventsRequest,
  type PushCommandsRequest,
  type SnapshotPageRequest,
} from "@glass/contracts/sync";
import { decodeSnapshotPageResponse } from "@glass/contracts/sync";
import { decodeInteger, decodeRecord } from "@glass/contracts/validation";

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

export class ProductHttpError extends Error {
  readonly boundary: BoundaryError;
  readonly status: number;

  constructor(status: number, boundary: BoundaryError) {
    super(boundary.message);
    this.name = "ProductHttpError";
    this.boundary = boundary;
    this.status = status;
  }
}

export class ProductProtocolError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = "ProductProtocolError";
    this.causeValue = causeValue;
  }
}

export const resolveApiBaseUrl = (input: string | undefined): string => {
  if (input === undefined || input.trim().length === 0) {
    throw new ProductProtocolError("EXPO_PUBLIC_GLASS_API_URL is required.");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new ProductProtocolError("EXPO_PUBLIC_GLASS_API_URL must be an absolute URL.", cause);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProductProtocolError("EXPO_PUBLIC_GLASS_API_URL must use HTTP or HTTPS.");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ProductProtocolError(
      "EXPO_PUBLIC_GLASS_API_URL must contain only an HTTP(S) origin.",
    );
  }
  return url.origin;
};

const decodeBoundaryError = (input: unknown): BoundaryError | null => {
  const record = decodeRecord(input, "$error");
  if (!record.ok) return null;
  const code = boundaryCodes.find((candidate) => candidate === record.value.code);
  if (
    code === undefined ||
    typeof record.value.message !== "string" ||
    typeof record.value.retryable !== "boolean"
  ) {
    return null;
  }
  const commandId =
    record.value.commandId === undefined
      ? undefined
      : decodeId<CommandId>(record.value.commandId, "$error.commandId");
  const currentVersion =
    record.value.currentVersion === undefined
      ? undefined
      : decodeInteger(record.value.currentVersion, "$error.currentVersion", { min: 1 });
  if (commandId?.ok === false || currentVersion?.ok === false) return null;
  return {
    code,
    message: record.value.message,
    retryable: record.value.retryable,
    ...(commandId?.ok === true ? { commandId: commandId.value } : {}),
    ...(currentVersion?.ok === true ? { currentVersion: currentVersion.value } : {}),
  };
};

const responseJson = async (response: Response): Promise<unknown> => {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (cause) {
    throw new ProductProtocolError("Glass Cloud returned non-JSON data.", cause);
  }
  if (!response.ok) {
    const boundary = decodeBoundaryError(body);
    if (boundary === null)
      throw new ProductProtocolError("Glass Cloud returned an invalid error response.", body);
    throw new ProductHttpError(response.status, boundary);
  }
  return body;
};

export type AuthenticatedProof = Readonly<{ userId: UserId }>;

export const createProductTransport = (apiBaseUrl: string, fetcher: typeof fetch = fetch) => {
  const request = async (path: string, init?: RequestInit): Promise<unknown> =>
    responseJson(
      await fetcher(`${apiBaseUrl}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...init?.headers,
        },
      }),
    );

  const getAuthenticatedProof = async (): Promise<AuthenticatedProof> => {
    const body = await request("/v1/authenticated-proof");
    const record = decodeRecord(body, "$proof");
    if (
      !record.ok ||
      record.value.authenticated !== true ||
      record.value.authority !== "glass-cloud"
    ) {
      throw new ProductProtocolError("Glass Cloud returned an invalid authenticated proof.", body);
    }
    const userId = decodeId<UserId>(record.value.userId, "$proof.userId");
    if (!userId.ok)
      throw new ProductProtocolError(
        "Glass Cloud returned an invalid user identifier.",
        userId.issues,
      );
    return { userId: userId.value };
  };

  const snapshot = async (input: SnapshotPageRequest): Promise<unknown> => {
    const params = new URLSearchParams({
      limit: String(input.limit),
      organizationId: input.organizationId,
    });
    if (input.through !== null) params.set("through", input.through);
    if (input.after !== null) {
      params.set("afterSection", input.after.section);
      params.set("afterId", input.after.id);
      if (input.after.section === "message") {
        params.set("afterThreadId", input.after.threadId);
        params.set("afterOrdinal", input.after.ordinal);
      }
    }
    const body = await request(`/v1/sync/snapshot?${params.toString()}`);
    const decoded = decodeSnapshotPageResponse(body, input);
    if (!decoded.ok)
      throw new ProductProtocolError(
        "Glass Cloud returned an invalid snapshot page.",
        decoded.issues,
      );
    return decoded.value;
  };

  const listOrganizations = async (
    userId: UserId,
    input: ListOrganizationsRequest,
  ): Promise<OrganizationsPage> => {
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (input.after !== null) params.set("after", input.after);
    const body = await request(`/v1/organizations?${params.toString()}`);
    const decoded = decodeOrganizationsPage(body);
    if (!decoded.ok)
      throw new ProductProtocolError(
        "Glass Cloud returned an invalid organization page.",
        decoded.issues,
      );
    if (decoded.value.items.some((item) => item.membership.userId !== userId)) {
      throw new ProductProtocolError(
        "Glass Cloud returned another user's organization membership.",
      );
    }
    return decoded.value;
  };

  const pull = async (input: PullEventsRequest): Promise<unknown> => {
    const params = new URLSearchParams({
      organizationId: input.organizationId,
      limit: String(input.limit),
      ...(input.after === null ? {} : { after: input.after }),
      ...(input.through === null ? {} : { through: input.through }),
    });
    const body = await request(`/v1/sync/pull?${params.toString()}`);
    const decoded = decodePullEventsResponse(body);
    if (!decoded.ok)
      throw new ProductProtocolError("Glass Cloud returned an invalid sync page.", decoded.issues);
    if (
      decoded.value.head.organizationId !== input.organizationId ||
      decoded.value.events.some((event) => event.organizationId !== input.organizationId)
    ) {
      throw new ProductProtocolError("Glass Cloud returned a sync page for another organization.");
    }
    return decoded.value;
  };

  const push = async (input: PushCommandsRequest): Promise<unknown> => {
    const body = await request("/v1/sync/push", { method: "POST", body: JSON.stringify(input) });
    const decoded = decodePushCommandsResponse(body);
    if (!decoded.ok)
      throw new ProductProtocolError(
        "Glass Cloud returned an invalid push result.",
        decoded.issues,
      );
    if (
      decoded.value.results.length !== input.commands.length ||
      decoded.value.results.some(
        (result, index) => result.commandId !== input.commands[index]?.commandId,
      )
    ) {
      throw new ProductProtocolError("Glass Cloud returned results for different commands.");
    }
    return decoded.value;
  };

  const loadNoteContent = async (
    organizationId: OrganizationId,
    noteId: SaveNoteContentRequest["noteId"],
  ): Promise<NoteContentResponse> => {
    const params = new URLSearchParams({ organizationId, noteId });
    const body = await request(`/v1/notes/content?${params.toString()}`);
    const decoded = decodeNoteContentResponse(body);
    if (!decoded.ok)
      throw new ProductProtocolError("Glass Cloud returned invalid note content.", decoded.issues);
    if (decoded.value.organizationId !== organizationId || decoded.value.noteId !== noteId) {
      throw new ProductProtocolError("Glass Cloud returned note content from another scope.");
    }
    return decoded.value;
  };

  const saveNoteContent = async (input: SaveNoteContentRequest): Promise<void> => {
    const body = await request("/v1/notes/content", {
      body: JSON.stringify(input),
      method: "PUT",
    });
    const decoded = decodeSaveNoteContentResponse(body);
    if (!decoded.ok)
      throw new ProductProtocolError(
        "Glass Cloud returned an invalid note save result.",
        decoded.issues,
      );
    if (
      decoded.value.organizationId !== input.organizationId ||
      decoded.value.noteId !== input.noteId
    ) {
      throw new ProductProtocolError("Glass Cloud returned a note save result from another scope.");
    }
  };

  return {
    getAuthenticatedProof,
    listOrganizations,
    loadNoteContent,
    outboxTransport: { push } satisfies OutboxTransport,
    saveNoteContent,
    snapshot,
    syncTransport: { pull } satisfies SyncTransport,
  };
};

export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof ProductHttpError && error.boundary.code === "UNAUTHENTICATED";

export const requiresResnapshot = (error: unknown): boolean =>
  error instanceof ProductHttpError &&
  (error.boundary.code === "CURSOR_EXPIRED" || error.boundary.code === "CURSOR_INVALID");

export const isTransientProductFailure = (error: unknown): boolean =>
  !(error instanceof ProductProtocolError) &&
  (!(error instanceof ProductHttpError) || error.boundary.retryable || error.status >= 500);

export const classifyProductTransportError = (error: unknown): TransportFailure => {
  if (isTransientProductFailure(error)) return { kind: "transient" };
  if (error instanceof ProductHttpError) {
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
  return {
    code: "invalid",
    currentVersion: null,
    kind: "permanent",
    message: error instanceof Error ? error.message : "Invalid Glass Cloud response.",
  };
};

export const drainThenSynchronize = async (
  drain: () => Promise<void>,
  synchronize: () => Promise<void>,
): Promise<void> => {
  await drain();
  await synchronize();
};
