import { describe, expect, it } from "vite-plus/test";

import type { SyncCursor } from "./ids.ts";
import { decodeMessageOrdinal, decodeSyncCursor } from "./ids.ts";

import { decodeProductMutation } from "./events.ts";
import { decodeProductEntity } from "./product.ts";
import {
  decodeProductSnapshot,
  decodePullEventsRequest,
  decodePullEventsResponse,
  decodePushCommandsRequest,
  decodePushCommandsResponse,
  decodeSnapshotPageRequest,
  decodeSnapshotPageResponse,
  maxPullResponseBytes,
  maxPushRequestBytes,
  maxPushCommands,
} from "./sync.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";

describe("durable decimal identifiers", () => {
  it("accepts the PostgreSQL bigint maximum and rejects the next value", () => {
    expect(decodeSyncCursor("9223372036854775807", "$cursor")).toMatchObject({ ok: true });
    expect(decodeSyncCursor("9223372036854775808", "$cursor")).toMatchObject({ ok: false });
    expect(decodeMessageOrdinal("9223372036854775807", "$ordinal")).toMatchObject({ ok: true });
    expect(decodeMessageOrdinal("9223372036854775808", "$ordinal")).toMatchObject({ ok: false });
    expect(decodeMessageOrdinal("0", "$ordinal")).toMatchObject({ ok: false });
  });
});

const projectUpdate = {
  commandId,
  organizationId,
  operation: {
    kind: "project.update",
    projectId,
    expectedVersion: 7,
    name: "Architecture",
  },
};

const deletedProjectEvent = (cursor: string, eventId: string) => ({
  action: "deleted",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  aggregateId: projectId,
  aggregateType: "project",
  aggregateVersion: 8,
  commandId,
  cursor,
  entity: null,
  eventId,
  occurredAt: "2026-08-02T12:00:00.000Z",
  organizationId,
});

describe("Glass product mutation contracts", () => {
  it("decodes a stable optimistic project mutation envelope", () => {
    expect(decodeProductMutation(projectUpdate)).toEqual({ ok: true, value: projectUpdate });
  });

  it("rejects malformed identifiers and missing expected versions", () => {
    const result = decodeProductMutation({
      ...projectUpdate,
      commandId: "not-an-id",
      operation: { ...projectUpdate.operation, expectedVersion: 0 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "$mutation.commandId",
        "$mutation.operation.expectedVersion",
      ]);
    }
  });

  it("requires explicit membership concurrency expectations", () => {
    const userId = "55555555-5555-4555-8555-555555555555";
    const mutation = (operation: unknown) => ({ commandId, organizationId, operation });
    expect(
      decodeProductMutation(
        mutation({
          kind: "member.put",
          userId,
          role: "member",
          expectedVersion: null,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      decodeProductMutation(
        mutation({ kind: "member.put", userId, role: "admin", expectedVersion: 2 }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      decodeProductMutation(mutation({ kind: "member.remove", userId, expectedVersion: 2 })),
    ).toMatchObject({ ok: true });
    expect(
      decodeProductMutation(mutation({ kind: "member.put", userId, role: "member" })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      decodeProductMutation(mutation({ kind: "member.remove", userId, expectedVersion: null })),
    ).toMatchObject({ ok: false });
  });

  it("keeps every pushed command inside the authorized organization", () => {
    expect(
      decodePushCommandsRequest({
        organizationId,
        commands: [{ ...projectUpdate, organizationId: otherOrganizationId }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("bounds atomic push batches", () => {
    expect(
      decodePushCommandsRequest({
        organizationId,
        commands: Array.from({ length: maxPushCommands + 1 }, () => projectUpdate),
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects duplicate command identifiers before an atomic push", () => {
    expect(
      decodePushCommandsRequest({
        organizationId,
        commands: [projectUpdate, projectUpdate],
      }),
    ).toMatchObject({ ok: false });
  });

  it("bounds the complete serialized push envelope", () => {
    expect(
      decodePushCommandsRequest({
        organizationId,
        commands: [{ ...projectUpdate, padding: "x".repeat(maxPushRequestBytes) }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("bounds message bodies by UTF-8 bytes rather than JavaScript code units", () => {
    expect(
      decodeProductMutation({
        commandId,
        organizationId,
        operation: {
          kind: "message.create",
          messageId: "99999999-9999-4999-8999-999999999999",
          projectId,
          threadId: "77777777-7777-4777-8777-777777777777",
          body: "😀".repeat(250_001),
        },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("Glass change-feed contracts", () => {
  it("rejects unknown fields at every sync envelope boundary", () => {
    expect(
      decodePullEventsRequest({
        organizationId,
        after: null,
        through: null,
        limit: 1,
        unexpected: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodePushCommandsRequest({
        organizationId,
        commands: [projectUpdate],
        unexpected: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodePushCommandsResponse({
        results: [{ status: "accepted", commandId, cursor: "1", eventCount: 1, extra: true }],
      }),
    ).toMatchObject({ ok: false });
    expect(decodePushCommandsResponse({ results: [], extra: true })).toMatchObject({ ok: false });
    expect(
      decodePullEventsResponse({
        events: [],
        hasMore: false,
        nextCursor: "0",
        head: {
          capturedAt: "2026-08-02T12:00:01.000Z",
          cursor: "0",
          organizationId,
          extra: true,
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("decodes a deletion tombstone and stable sync head", () => {
    const response = {
      events: [deletedProjectEvent("42", "66666666-6666-4666-8666-666666666666")],
      hasMore: false,
      nextCursor: "42",
      head: {
        capturedAt: "2026-08-02T12:00:01.000Z",
        cursor: "42",
        organizationId,
      },
    };

    expect(decodePullEventsResponse(response, { after: "41" as SyncCursor })).toEqual({
      ok: true,
      value: response,
    });
  });

  it("rejects duplicate or regressing event cursors", () => {
    const eventId = "66666666-6666-4666-8666-666666666666";
    expect(
      decodePullEventsResponse({
        events: [
          deletedProjectEvent("42", eventId),
          deletedProjectEvent("42", "77777777-7777-4777-8777-777777777777"),
        ],
        hasMore: false,
        nextCursor: "42",
        head: {
          capturedAt: "2026-08-02T12:00:01.000Z",
          cursor: "42",
          organizationId,
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects gaps from the requested cursor and between events", () => {
    const response = {
      events: [
        deletedProjectEvent("42", "66666666-6666-4666-8666-666666666666"),
        deletedProjectEvent("44", "77777777-7777-4777-8777-777777777777"),
      ],
      hasMore: false,
      nextCursor: "44",
      head: {
        capturedAt: "2026-08-02T12:00:01.000Z",
        cursor: "44",
        organizationId,
      },
    };

    expect(decodePullEventsResponse(response, { after: "41" as SyncCursor })).toMatchObject({
      ok: false,
    });
    expect(
      decodePullEventsResponse(
        { ...response, events: [response.events[1]], nextCursor: "44" },
        { after: "41" as SyncCursor },
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps an empty page at its requested cursor", () => {
    const response = {
      events: [],
      hasMore: false,
      nextCursor: "41",
      head: {
        capturedAt: "2026-08-02T12:00:01.000Z",
        cursor: "44",
        organizationId,
      },
    };

    expect(decodePullEventsResponse(response, { after: "41" as SyncCursor })).toEqual({
      ok: true,
      value: response,
    });
    expect(
      decodePullEventsResponse({ ...response, nextCursor: "42" }, { after: "41" as SyncCursor }),
    ).toMatchObject({ ok: false });
  });

  it("bounds the complete serialized pull response", () => {
    expect(
      decodePullEventsResponse({
        events: [],
        hasMore: false,
        nextCursor: "0",
        head: {
          capturedAt: "2026-08-02T12:00:01.000Z",
          cursor: "0",
          organizationId,
        },
        padding: "x".repeat(maxPullResponseBytes),
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("Glass product snapshot contracts", () => {
  const snapshot = {
    organization: {
      id: organizationId,
      name: "Glass",
      version: 1,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    },
    members: [],
    projects: [],
    threads: [],
    messages: [],
    artifacts: [],
    cursor: "42",
    capturedAt: "2026-08-02T12:00:01.000Z",
  };

  it("decodes only Glass-owned product records", () => {
    expect(decodeProductSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it("rejects fields outside the Glass product snapshot", () => {
    expect(decodeProductSnapshot({ ...snapshot, unexpected: [] })).toMatchObject({ ok: false });
  });

  it("rejects duplicate identities and orphaned project relationships", () => {
    const project = {
      id: projectId,
      organizationId,
      name: "Project",
      version: 1,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
    expect(decodeProductSnapshot({ ...snapshot, projects: [project, project] })).toMatchObject({
      ok: false,
    });
    expect(
      decodeProductSnapshot({
        ...snapshot,
        threads: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            organizationId,
            projectId,
            title: null,
            version: 1,
            createdAt: "2026-08-02T12:00:00.000Z",
            updatedAt: "2026-08-02T12:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects messages and artifacts whose thread is absent or in another project", () => {
    const secondProjectId = "88888888-8888-4888-8888-888888888888";
    const threadId = "77777777-7777-4777-8777-777777777777";
    const baseRecord = {
      organizationId,
      version: 1,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
    const projects = [
      { ...baseRecord, id: projectId, name: "One" },
      { ...baseRecord, id: secondProjectId, name: "Two" },
    ];
    const threads = [{ ...baseRecord, id: threadId, projectId, title: null }];
    expect(
      decodeProductSnapshot({
        ...snapshot,
        projects,
        threads,
        messages: [
          {
            ...baseRecord,
            id: "99999999-9999-4999-8999-999999999999",
            projectId: secondProjectId,
            threadId,
            authorUserId: "55555555-5555-4555-8555-555555555555",
            body: "Cross-project",
            ordinal: "1",
          },
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeProductSnapshot({
        ...snapshot,
        projects,
        threads,
        artifacts: [
          {
            ...baseRecord,
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            projectId: secondProjectId,
            threadId,
            kind: "agent-output",
            name: "Cross-project",
            body: { ok: true },
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it("validates typed, stable snapshot pages and message ordinal continuations", () => {
    const request = decodeSnapshotPageRequest({
      organizationId,
      through: "42",
      after: {
        section: "message",
        threadId: "77777777-7777-4777-8777-777777777777",
        ordinal: "9007199254740993",
        id: "99999999-9999-4999-8999-999999999998",
      },
      limit: 10,
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const response = {
      organization: snapshot.organization,
      head: { organizationId, cursor: "42", capturedAt: snapshot.capturedAt },
      entities: [
        {
          section: "message",
          entity: {
            id: "99999999-9999-4999-8999-999999999999",
            organizationId,
            projectId,
            threadId: "77777777-7777-4777-8777-777777777777",
            authorUserId: "55555555-5555-4555-8555-555555555555",
            body: "Next",
            ordinal: "9007199254740994",
            version: 1,
            createdAt: "2026-08-02T12:00:00.000Z",
            updatedAt: "2026-08-02T12:00:00.000Z",
          },
        },
      ],
      hasMore: true,
      next: {
        section: "message",
        threadId: "77777777-7777-4777-8777-777777777777",
        ordinal: "9007199254740994",
        id: "99999999-9999-4999-8999-999999999999",
      },
    };
    expect(decodeSnapshotPageResponse(response, request.value)).toMatchObject({ ok: true });
    expect(
      decodeSnapshotPageResponse(
        { ...response, next: { ...response.next, ordinal: "2" } },
        request.value,
      ),
    ).toMatchObject({ ok: false });
  });

  it("requires each thread's message subsequence to have increasing unique ordinals", () => {
    const base = {
      organizationId,
      version: 1,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
    const firstThread = "77777777-7777-4777-8777-777777777777";
    const secondThread = "88888888-8888-4888-8888-888888888888";
    const projects = [{ ...base, id: projectId, name: "Project" }];
    const threads = [
      { ...base, id: firstThread, projectId, title: null },
      { ...base, id: secondThread, projectId, title: null },
    ];
    const message = (id: string, threadId: string, ordinal: string) => ({
      ...base,
      id,
      projectId,
      threadId,
      ordinal,
      authorUserId: "55555555-5555-4555-8555-555555555555",
      body: id,
    });
    const first = message("90000000-0000-4000-8000-000000000001", firstThread, "1");
    const other = message("90000000-0000-4000-8000-000000000002", secondThread, "9");
    const next = message("90000000-0000-4000-8000-000000000003", firstThread, "2");
    expect(
      decodeProductSnapshot({ ...snapshot, projects, threads, messages: [first, other, next] }),
    ).toMatchObject({ ok: true });
    expect(
      decodeProductSnapshot({
        ...snapshot,
        projects,
        threads,
        messages: [next, other, { ...first, id: "90000000-0000-4000-8000-000000000004" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      decodeProductSnapshot({
        ...snapshot,
        projects,
        threads,
        messages: [first, other, { ...next, ordinal: "1" }],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("Glass output artifact contracts", () => {
  const artifact = {
    body: { status: "ready" },
    createdAt: "2026-08-02T12:00:00.000Z",
    id: "77777777-7777-4777-8777-777777777777",
    kind: "agent-output",
    name: "Result",
    organizationId,
    projectId,
    threadId: null,
    updatedAt: "2026-08-02T12:00:00.000Z",
    version: 1,
  };

  it("accepts the explicit Glass-owned output kind", () => {
    expect(decodeProductEntity("artifact", artifact)).toEqual({ ok: true, value: artifact });
  });

  it("rejects free-form artifact kinds", () => {
    expect(decodeProductEntity("artifact", { ...artifact, kind: "custom" })).toMatchObject({
      ok: false,
    });
  });
});
