import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProductEvent } from "@glass/contracts/events";
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
import type { ProductSnapshot } from "@glass/contracts/sync";

const asyncStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: asyncStorage }));

import { createOrganizationBootstrapEnvelope } from "./product-mutations.ts";
import {
  applyProductEvents,
  createMobileOutboxStorage,
  createMobileProductStorage,
  loadActiveOrganization,
  loadOrganizationBootstrap,
  saveActiveOrganization,
  saveOrganizationBootstrap,
} from "./storage.ts";
import { activeOrganizationKey, organizationBootstrapKey, outboxKey } from "./storage-keys.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const projectId = "00000000-0000-4000-8000-000000000002" as ProjectId;
const threadId = "00000000-0000-4000-8000-000000000003" as ThreadId;
const messageId = "00000000-0000-4000-8000-000000000004" as MessageId;
const artifactId = "00000000-0000-4000-8000-000000000005" as ArtifactId;
const userId = "00000000-0000-4000-8000-000000000006" as UserId;
const timestamp = "2026-08-02T10:00:00.000Z" as IsoDateTime;

const snapshot: ProductSnapshot = {
  artifacts: [
    {
      body: {},
      createdAt: timestamp,
      id: artifactId,
      kind: "agent-output",
      name: "Output",
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
      ordinal: "1" as MessageOrdinal,
      organizationId,
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
      name: "Core",
      organizationId,
      updatedAt: timestamp,
      version: 1,
    },
  ],
  threads: [
    {
      createdAt: timestamp,
      id: threadId,
      organizationId,
      projectId,
      title: null,
      updatedAt: timestamp,
      version: 1,
    },
  ],
};

describe("mobile product projection", () => {
  beforeEach(() => {
    asyncStorage.values.clear();
    asyncStorage.getItem.mockImplementation(
      async (key: string) => asyncStorage.values.get(key) ?? null,
    );
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      asyncStorage.values.set(key, value);
    });
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      asyncStorage.values.delete(key);
    });
  });

  it("cascades a thread tombstone through messages and thread-linked artifacts", () => {
    const event: ProductEvent = {
      action: "deleted",
      actorUserId: userId,
      aggregateId: threadId,
      aggregateType: "thread",
      aggregateVersion: 2,
      commandId: "00000000-0000-4000-8000-000000000007" as CommandId,
      cursor: "2" as SyncCursor,
      entity: null,
      eventId: "00000000-0000-4000-8000-000000000008" as EventId,
      occurredAt: timestamp,
      organizationId,
    };
    const projected = applyProductEvents(snapshot, [event]);
    expect(projected.threads).toEqual([]);
    expect(projected.messages).toEqual([]);
    expect(projected.artifacts).toEqual([]);
  });

  it("recovers a self-contained organization bootstrap before selection or scoped enqueue", async () => {
    const ids = [organizationId, "00000000-0000-4000-8000-000000000007"][Symbol.iterator]();
    const created = createOrganizationBootstrapEnvelope(
      "Glass",
      () => ids.next().value ?? "",
      () => Date.parse(timestamp),
    );
    await saveOrganizationBootstrap(userId, created.envelope);

    expect(await loadActiveOrganization(userId)).toBeNull();
    expect((await loadOrganizationBootstrap(userId))?.mutation).toEqual(created.envelope.mutation);
    const recovered = await createMobileOutboxStorage({ organizationId, userId }).load();
    expect(recovered).toEqual([created.envelope]);
  });

  it("deduplicates the bootstrap after scoped persistence and selection", async () => {
    const ids = [organizationId, "00000000-0000-4000-8000-000000000007"][Symbol.iterator]();
    const created = createOrganizationBootstrapEnvelope(
      "Glass",
      () => ids.next().value ?? "",
      () => Date.parse(timestamp),
    );
    await saveOrganizationBootstrap(userId, created.envelope);
    const storage = createMobileOutboxStorage({ organizationId, userId });
    await storage.put(created.envelope);
    await saveActiveOrganization(userId, organizationId);

    expect(await loadActiveOrganization(userId)).toBe(organizationId);
    expect(await storage.load()).toHaveLength(1);
  });

  it("preserves bootstrap recovery when accepted-command scoped removal fails", async () => {
    const ids = [organizationId, "00000000-0000-4000-8000-000000000007"][Symbol.iterator]();
    const created = createOrganizationBootstrapEnvelope(
      "Glass",
      () => ids.next().value ?? "",
      () => Date.parse(timestamp),
    );
    await saveOrganizationBootstrap(userId, created.envelope);
    const scope = { organizationId, userId };
    const storage = createMobileOutboxStorage(scope);
    await storage.put(created.envelope);
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      if (key === outboxKey(scope) && value === "[]") throw new Error("local remove failed");
      asyncStorage.values.set(key, value);
    });

    await expect(storage.remove(created.envelope.mutation.commandId)).rejects.toThrow(
      "local remove failed",
    );
    expect(await loadOrganizationBootstrap(userId)).not.toBeNull();
  });

  it("preserves the bootstrap when clearing it fails after scoped removal", async () => {
    const ids = [organizationId, "00000000-0000-4000-8000-000000000007"][Symbol.iterator]();
    const created = createOrganizationBootstrapEnvelope(
      "Glass",
      () => ids.next().value ?? "",
      () => Date.parse(timestamp),
    );
    await saveOrganizationBootstrap(userId, created.envelope);
    const scope = { organizationId, userId };
    const storage = createMobileOutboxStorage(scope);
    await storage.put(created.envelope);
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === organizationBootstrapKey(userId)) throw new Error("intent remove failed");
      asyncStorage.values.delete(key);
    });

    await expect(storage.remove(created.envelope.mutation.commandId)).rejects.toThrow(
      "intent remove failed",
    );
    expect(asyncStorage.values.get(outboxKey(scope))).toBe("[]");
    expect(await loadOrganizationBootstrap(userId)).not.toBeNull();
  });

  it("clears an invalid active organization presentation key", async () => {
    asyncStorage.values.set(activeOrganizationKey(userId), "not-a-uuid");
    expect(await loadActiveOrganization(userId)).toBeNull();
    expect(asyncStorage.values.has(activeOrganizationKey(userId))).toBe(false);
  });

  it("does not let an overlapping stale mobile write regress the durable cursor", async () => {
    const published: string[] = [];
    const storage = createMobileProductStorage({ organizationId, userId }, (next) =>
      published.push(next.cursor),
    );
    const newer = { ...snapshot, cursor: "3" as SyncCursor };
    const stale = { ...snapshot, cursor: "2" as SyncCursor };
    await Promise.all([storage.installSnapshot(newer), storage.installSnapshot(stale)]);

    expect((await storage.loadSnapshot())?.cursor).toBe("3");
    expect(published.at(-1)).toBe("3");
  });
});
