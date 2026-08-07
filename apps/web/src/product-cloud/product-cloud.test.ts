import type {
  ArtifactId,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  MessageOrdinal,
  OrganizationId,
  ProjectId,
  SyncCursor,
  ThreadId,
  UserId,
} from "@glass/contracts/ids";
import type { ProductEvent } from "@glass/contracts/events";
import type { ProductSnapshot } from "@glass/contracts/sync";
import { createDocument } from "@openeditor/core";
import { describe, expect, it } from "vite-plus/test";

import type { SyncCheckpoint } from "@glass/client-runtime/sync";
import {
  applyProductEvents,
  decodeActiveOrganizationPreference,
  mergeOrganizationBootstrap,
  productStorageKey,
  shouldPersistCursor,
  validateStoredProductState,
} from "./indexed-db.ts";
import {
  createNoteMutation,
  createOrganizationBootstrapEnvelope,
  createOrganizationMutation,
  createProjectMutation,
} from "./product-mutations.ts";
import {
  classifyProductTransportError,
  createProductCloudTransport,
  drainThenSynchronize,
  ProductCloudProtocolError,
  ProductCloudRequestError,
  resolveApiUrl,
  synchronizeFromCheckpoint,
} from "./transport.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const otherOrganizationId = "00000000-0000-4000-8000-000000000002" as OrganizationId;
const userId = "00000000-0000-4000-8000-000000000003" as UserId;
const otherUserId = "00000000-0000-4000-8000-000000000004" as UserId;
const projectId = "00000000-0000-4000-8000-000000000005" as ProjectId;
const threadId = "00000000-0000-4000-8000-000000000006" as ThreadId;
const messageId = "00000000-0000-4000-8000-000000000007" as MessageId;
const artifactId = "00000000-0000-4000-8000-000000000009" as ArtifactId;
const commandId = "00000000-0000-4000-8000-000000000010" as CommandId;
const eventId = "00000000-0000-4000-8000-000000000011" as EventId;
const timestamp = "2026-08-02T10:00:00.000Z" as IsoDateTime;

describe("active organization preference", () => {
  it("accepts only the current versioned device preference", () => {
    expect(decodeActiveOrganizationPreference({ organizationId, schemaVersion: 1 })).toBe(
      organizationId,
    );
    expect(decodeActiveOrganizationPreference(organizationId)).toBeNull();
    expect(decodeActiveOrganizationPreference({ organizationId, schemaVersion: 2 })).toBeNull();
    expect(
      decodeActiveOrganizationPreference({ organizationId: "not-an-id", schemaVersion: 1 }),
    ).toBeNull();
  });
});

const snapshot = (): ProductSnapshot => ({
  artifacts: [
    {
      body: {},
      createdAt: timestamp,
      id: artifactId,
      kind: "agent-output",
      name: "Report",
      organizationId,
      projectId,
      threadId,
      updatedAt: timestamp,
      version: 1,
    },
  ],
  capturedAt: timestamp,
  cursor: "1" as SyncCursor,
  members: [],
  messages: [
    {
      authorUserId: userId,
      body: "Hello",
      createdAt: timestamp,
      id: messageId,
      organizationId,
      ordinal: "1" as MessageOrdinal,
      projectId,
      threadId,
      updatedAt: timestamp,
      version: 1,
    },
  ],
  organization: {
    createdAt: timestamp,
    id: organizationId,
    name: "Glass",
    updatedAt: timestamp,
    version: 1,
  },
  projects: [
    {
      createdAt: timestamp,
      description: null,
      id: projectId,
      name: "Project",
      organizationId,
      updatedAt: timestamp,
      version: 2,
    },
  ],
  threads: [
    {
      createdAt: timestamp,
      id: threadId,
      organizationId,
      projectId,
      title: "Thread",
      updatedAt: timestamp,
      version: 1,
    },
  ],
});

const checkpoint = (cursor: string): SyncCheckpoint => ({
  cursor: cursor as SyncCursor,
  head: { capturedAt: timestamp, cursor: cursor as SyncCursor, organizationId },
  organizationId,
  schemaVersion: 1,
});

const deletion = (
  aggregateType: ProductEvent["aggregateType"],
  aggregateId: string,
  aggregateVersion: number,
): ProductEvent => ({
  action: "deleted",
  actorUserId: userId,
  aggregateId,
  aggregateType,
  aggregateVersion,
  commandId,
  cursor: "2" as SyncCursor,
  entity: null,
  eventId,
  occurredAt: timestamp,
  organizationId,
});

describe("web product-cloud adapters", () => {
  it("scopes durable keys by both authenticated user and organization", () => {
    const first = productStorageKey(userId, organizationId, "snapshot");
    expect(first).not.toBe(productStorageKey(otherUserId, organizationId, "snapshot"));
    expect(first).not.toBe(productStorageKey(userId, otherOrganizationId, "snapshot"));
  });

  it("drains recovered commands before pulling the projection used for live UI", async () => {
    const order: string[] = [];
    await drainThenSynchronize(
      async () => {
        order.push("drain");
      },
      async () => {
        order.push("synchronize");
      },
    );
    expect(order).toEqual(["drain", "synchronize"]);
  });

  it("reconnects a validated cache without requesting a full snapshot", async () => {
    let snapshotRequests = 0;
    await synchronizeFromCheckpoint({
      drain: async () => undefined,
      hasCachedSnapshot: true,
      installSnapshot: async () => {
        snapshotRequests += 1;
      },
      synchronize: async () => undefined,
    });
    expect(snapshotRequests).toBe(0);
  });

  it("drains a recovered first-organization command before its initial snapshot", async () => {
    const order: string[] = [];
    await synchronizeFromCheckpoint({
      drain: async () => {
        order.push("drain");
      },
      hasCachedSnapshot: false,
      installSnapshot: async () => {
        order.push("snapshot");
      },
      synchronize: async () => {
        order.push("synchronize");
      },
    });
    expect(order).toEqual(["drain", "snapshot", "synchronize"]);
  });

  it("installs one fresh snapshot and retries when the durable cursor is invalid", async () => {
    let snapshotRequests = 0;
    let synchronizeCalls = 0;
    await synchronizeFromCheckpoint({
      drain: async () => undefined,
      hasCachedSnapshot: true,
      installSnapshot: async () => {
        snapshotRequests += 1;
      },
      synchronize: async () => {
        synchronizeCalls += 1;
        if (synchronizeCalls === 1) {
          throw new ProductCloudRequestError(409, {
            code: "CURSOR_INVALID",
            message: "Snapshot required.",
            retryable: false,
          });
        }
      },
    });
    expect(snapshotRequests).toBe(1);
    expect(synchronizeCalls).toBe(2);
  });

  it("creates metadata-only note mutations with secure-source UUIDs", () => {
    const ids = [artifactId, commandId][Symbol.iterator]();
    const created = createNoteMutation(
      { name: "Plan", organizationId, projectId },
      () => ids.next().value ?? "",
    );

    expect(created.noteId).toBe(artifactId);
    expect(created.mutation).toEqual({
      commandId,
      operation: {
        artifactId,
        icon: null,
        kind: "note.create",
        name: "Plan",
        projectId,
      },
      organizationId,
    });
    expect("content" in created.mutation.operation).toBe(false);
  });

  it("creates durable organization and project commands with client-generated IDs", () => {
    const organizationIds = [otherOrganizationId, commandId][Symbol.iterator]();
    const organization = createOrganizationMutation(
      "Acme",
      () => organizationIds.next().value ?? "",
    );
    expect(organization.mutation).toEqual({
      commandId,
      operation: { kind: "organization.create", name: "Acme" },
      organizationId: otherOrganizationId,
    });

    const projectIds = [projectId, commandId][Symbol.iterator]();
    const project = createProjectMutation(
      { description: "Durable", name: "Core", organizationId },
      () => projectIds.next().value ?? "",
    );
    expect(project.mutation).toEqual({
      commandId,
      operation: {
        description: "Durable",
        kind: "project.create",
        name: "Core",
        projectId,
      },
      organizationId,
    });
  });

  it("keeps first-organization recovery self-contained before and after scoped enqueue", () => {
    const ids = [otherOrganizationId, commandId][Symbol.iterator]();
    const created = createOrganizationBootstrapEnvelope(
      "Acme",
      () => ids.next().value ?? "",
      () => Date.parse(timestamp),
    );
    expect(created.envelope.mutation.operation.kind).toBe("organization.create");
    expect(mergeOrganizationBootstrap([], created.envelope, otherOrganizationId)).toEqual([
      created.envelope,
    ]);
    expect(
      mergeOrganizationBootstrap([created.envelope], created.envelope, otherOrganizationId),
    ).toEqual([created.envelope]);
  });

  it("rejects a cached snapshot whose checkpoint is absent, ahead, or mismatched", () => {
    const current = snapshot();
    expect(validateStoredProductState(current, checkpoint("1"), organizationId)).toEqual(current);
    expect(validateStoredProductState(current, undefined, organizationId)).toBeNull();
    expect(validateStoredProductState(current, checkpoint("2"), organizationId)).toBeNull();
    expect(validateStoredProductState(current, checkpoint("1"), otherOrganizationId)).toBeNull();
  });

  it("refuses to overwrite a newer durable web cursor", () => {
    expect(shouldPersistCursor(null, "1" as SyncCursor)).toBe(true);
    expect(shouldPersistCursor("3" as SyncCursor, "3" as SyncCursor)).toBe(true);
    expect(shouldPersistCursor("3" as SyncCursor, "2" as SyncCursor)).toBe(false);
  });

  it("ignores stale aggregate events", () => {
    const current = snapshot();
    const reduced = applyProductEvents(
      current,
      [deletion("project", projectId, 2)],
      checkpoint("2"),
    );
    expect(reduced.projects).toEqual(current.projects);
    expect(reduced.threads).toEqual(current.threads);
  });

  it("cascades project tombstones through its local projection", () => {
    const reduced = applyProductEvents(
      snapshot(),
      [deletion("project", projectId, 3)],
      checkpoint("2"),
    );
    expect(reduced.projects).toEqual([]);
    expect(reduced.threads).toEqual([]);
    expect(reduced.messages).toEqual([]);
    expect(reduced.artifacts).toEqual([]);
  });

  it("cascades thread tombstones through messages and thread-linked artifacts", () => {
    const reduced = applyProductEvents(
      snapshot(),
      [deletion("thread", threadId, 2)],
      checkpoint("2"),
    );
    expect(reduced.threads).toEqual([]);
    expect(reduced.messages).toEqual([]);
    expect(reduced.artifacts).toEqual([]);
  });

  it("uses only an explicit HTTP(S) API base URL", () => {
    expect(resolveApiUrl(undefined, "/v1/sync/pull")).toBe("/v1/sync/pull");
    expect(resolveApiUrl("https://api.glass.example", "/v1/sync/pull")).toBe(
      "https://api.glass.example/v1/sync/pull",
    );
    expect(() => resolveApiUrl("file:///tmp/glass", "/v1/sync/pull")).toThrow(
      ProductCloudProtocolError,
    );
    expect(() => resolveApiUrl("https://api.glass.example/prefix", "/v1/sync/pull")).toThrow(
      ProductCloudProtocolError,
    );
  });

  it("distinguishes retryable transport failures from authoritative denial", () => {
    expect(
      classifyProductTransportError(
        new ProductCloudRequestError(401, {
          code: "UNAUTHENTICATED",
          message: "Session expired.",
          retryable: false,
        }),
      ),
    ).toEqual({
      code: "unauthenticated",
      currentVersion: null,
      kind: "permanent",
      message: "Session expired.",
    });
    expect(
      classifyProductTransportError(
        new ProductCloudRequestError(403, {
          code: "FORBIDDEN",
          message: "Membership is required.",
          retryable: false,
        }),
      ),
    ).toEqual({
      code: "forbidden",
      currentVersion: null,
      kind: "permanent",
      message: "Membership is required.",
    });
    expect(
      classifyProductTransportError(
        new ProductCloudRequestError(503, {
          code: "PRODUCT_UNAVAILABLE",
          message: "Try again.",
          retryable: true,
        }),
      ),
    ).toEqual({ kind: "transient" });
  });

  it("rejects a snapshot returned for another organization", async () => {
    const otherSnapshotPage = {
      entities: [],
      hasMore: false,
      head: { capturedAt: timestamp, cursor: "1", organizationId: otherOrganizationId },
      next: null,
      organization: { ...snapshot().organization, id: otherOrganizationId },
    };
    const fetcher = (() =>
      Promise.resolve(
        new Response(JSON.stringify(otherSnapshotPage), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )) as typeof fetch;
    await expect(
      createProductCloudTransport(undefined, fetcher).snapshot({
        after: null,
        limit: 500,
        organizationId,
        through: null,
      }),
    ).rejects.toBeInstanceOf(ProductCloudProtocolError);
  });

  it("paginates organization discovery and rejects another user's memberships", async () => {
    const requests: string[] = [];
    const fetcher = ((input: RequestInfo | URL) => {
      requests.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                membership: {
                  createdAt: timestamp,
                  organizationId,
                  role: "owner",
                  updatedAt: timestamp,
                  userId: otherUserId,
                  version: 1,
                },
                organization: snapshot().organization,
              },
            ],
            nextCursor: organizationId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;
    await expect(
      createProductCloudTransport(undefined, fetcher).listOrganizations(userId, {
        after: otherOrganizationId,
        limit: 25,
      }),
    ).rejects.toBeInstanceOf(ProductCloudProtocolError);
    expect(requests[0]).toContain(`after=${otherOrganizationId}`);
    expect(requests[0]).toContain("limit=25");
  });

  it("rejects push results that do not match the submitted command", async () => {
    const fetcher = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                commandId: eventId,
                cursor: "2",
                eventCount: 1,
                status: "accepted",
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      )) as typeof fetch;
    await expect(
      createProductCloudTransport(undefined, fetcher).push({
        commands: [
          {
            commandId,
            operation: {
              description: null,
              kind: "project.create",
              name: "Project",
              projectId,
            },
            organizationId,
          },
        ],
        organizationId,
      }),
    ).rejects.toBeInstanceOf(ProductCloudProtocolError);
  });

  it("loads note content through the dedicated authenticated and scoped route", async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: createDocument(),
            noteId: artifactId,
            organizationId,
            savedAt: timestamp,
            savedByUserId: userId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;

    const result = await createProductCloudTransport(undefined, fetcher).loadNoteContent(
      organizationId,
      artifactId,
    );

    expect(result.content).toEqual(createDocument());
    expect(requests[0]?.input).toContain(`/v1/notes/content?organizationId=${organizationId}`);
    expect(requests[0]?.input).toContain(`noteId=${artifactId}`);
    expect(requests[0]?.init?.credentials).toBe("include");
  });

  it("rejects note save acknowledgements from another scope", async () => {
    const fetcher = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            noteId: artifactId,
            organizationId: otherOrganizationId,
            savedAt: timestamp,
            savedByUserId: userId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      )) as typeof fetch;
    await expect(
      createProductCloudTransport(undefined, fetcher).saveNoteContent({
        content: createDocument(),
        noteId: artifactId,
        organizationId,
      }),
    ).rejects.toBeInstanceOf(ProductCloudProtocolError);
  });

  it("saves editor payloads only through the dedicated note route", async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            noteId: artifactId,
            organizationId,
            savedAt: timestamp,
            savedByUserId: userId,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;
    const transport = createProductCloudTransport(undefined, fetcher);

    await transport.saveNoteContent({
      content: createDocument(),
      noteId: artifactId,
      organizationId,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/v1/notes/content");
    expect(requests[0]?.init?.method).toBe("PUT");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      content: createDocument(),
      noteId: artifactId,
      organizationId,
    });
    expect("commands" in body).toBe(false);
  });
});
