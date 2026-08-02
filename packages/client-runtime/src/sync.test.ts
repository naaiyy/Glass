import type {
  CommandId,
  EventId,
  IsoDateTime,
  OrganizationId,
  SyncCursor,
  UserId,
} from "@glass/contracts/ids";
import type { ProductEvent } from "@glass/contracts/events";
import { describe, expect, it } from "vite-plus/test";

import {
  createSyncEngine,
  syncCheckpointVersion,
  type SyncCheckpoint,
  type SyncCommit,
} from "./sync.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const userId = "00000000-0000-4000-8000-000000000002" as UserId;
const commandId = "00000000-0000-4000-8000-000000000003" as CommandId;
const capturedAt = "2026-08-02T10:00:00.000Z" as IsoDateTime;

const event = (cursor: string, id: string): ProductEvent => ({
  action: "deleted",
  actorUserId: userId,
  aggregateId: "00000000-0000-4000-8000-000000000099",
  aggregateType: "project",
  aggregateVersion: 1,
  commandId,
  cursor: cursor as SyncCursor,
  entity: null,
  eventId: id as EventId,
  occurredAt: capturedAt,
  organizationId,
});

const checkpoint = (cursor: string): SyncCheckpoint => ({
  cursor: cursor as SyncCursor,
  organizationId,
  schemaVersion: syncCheckpointVersion,
  head: { capturedAt, cursor: cursor as SyncCursor, organizationId },
});

describe("product cursor synchronization", () => {
  it("applies a contiguous page and keeps sync state independent from connection state", async () => {
    const newEvent = event("3", "00000000-0000-4000-8000-000000000011");
    const commits: SyncCommit[] = [];
    const states: string[] = [];
    const engine = createSyncEngine({
      organizationId,
      storage: {
        load: async () => checkpoint("2"),
        commit: async (commit) => {
          commits.push(commit);
        },
      },
      transport: {
        pull: async () => ({
          events: [newEvent],
          hasMore: false,
          nextCursor: "3",
          head: { capturedAt, cursor: "3", organizationId },
        }),
      },
    });
    engine.subscribe((state) => states.push(state.status));

    await engine.initialize();
    expect(engine.getState()).toEqual({ cursor: "2", status: "cached" });
    await engine.synchronize();

    expect(commits).toHaveLength(1);
    expect(commits[0]?.events.map((item) => item.cursor)).toEqual(["3"]);
    expect(engine.getState()).toEqual({ cursor: "3", status: "live" });
    expect(states).toContain("synchronizing");
    expect(states.at(-1)).toBe("live");
  });

  it("rejects a page that skips a durable organization cursor", async () => {
    let committed = false;
    const engine = createSyncEngine({
      organizationId,
      storage: {
        load: async () => checkpoint("2"),
        commit: async () => {
          committed = true;
        },
      },
      transport: {
        pull: async () => ({
          events: [event("4", "00000000-0000-4000-8000-000000000012")],
          hasMore: false,
          nextCursor: "4",
          head: { capturedAt, cursor: "4", organizationId },
        }),
      },
    });

    await engine.initialize();
    await expect(engine.synchronize()).rejects.toThrow("Sync response failed validation");
    expect(committed).toBe(false);
    expect(engine.getState()).toMatchObject({ cursor: "2", status: "error" });
  });

  it("publishes an explicit sync error without inventing a connection state", async () => {
    const engine = createSyncEngine({
      organizationId,
      storage: { load: async () => checkpoint("2"), commit: async () => undefined },
      transport: { pull: async () => Promise.reject(new Error("network unavailable")) },
    });

    await engine.initialize();
    await expect(engine.synchronize()).rejects.toThrow("network unavailable");
    expect(engine.getState()).toMatchObject({ cursor: "2", status: "error" });
  });
});
