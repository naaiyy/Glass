import type { OrganizationId, SyncCursor } from "@glass/contracts/ids";
import { decodeId, decodeSyncCursor } from "@glass/contracts/ids";
import type { ProductEvent } from "@glass/contracts/events";
import type { PullEventsRequest, PullEventsResponse, SyncHead } from "@glass/contracts/sync";
import { decodePullEventsResponse, maxPullEvents } from "@glass/contracts/sync";
import { decodeRecord } from "@glass/contracts/validation";

export const syncCheckpointVersion = 1 as const;

export type SyncCheckpoint = Readonly<{
  cursor: SyncCursor;
  organizationId: OrganizationId;
  schemaVersion: typeof syncCheckpointVersion;
  head: SyncHead;
}>;

export type SyncCommit = Readonly<{
  checkpoint: SyncCheckpoint;
  events: readonly ProductEvent[];
}>;

export interface SyncStorage {
  /** Stored values cross a persistence boundary and are decoded by the engine. */
  load(organizationId: OrganizationId): Promise<unknown | null>;
  /** Applies events and stores their checkpoint atomically. */
  commit(commit: SyncCommit): Promise<void>;
}

export interface SyncTransport {
  /** Transport responses are untrusted and are decoded by the engine. */
  pull(request: PullEventsRequest): Promise<unknown>;
}

export type ProductSyncState =
  | Readonly<{ cursor: SyncCursor | null; status: "cached" }>
  | Readonly<{ cursor: SyncCursor | null; status: "synchronizing" }>
  | Readonly<{ cursor: SyncCursor; status: "live" }>
  | Readonly<{ cursor: SyncCursor | null; error: SyncRuntimeError; status: "error" }>;

export class SyncRuntimeError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = "SyncRuntimeError";
    this.causeValue = causeValue;
  }
}

const compareCursor = (left: SyncCursor, right: SyncCursor): number => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
};

export const decodeSyncCheckpoint = (input: unknown): SyncCheckpoint => {
  const record = decodeRecord(input, "$checkpoint");
  if (!record.ok || record.value.schemaVersion !== syncCheckpointVersion) {
    throw new SyncRuntimeError("Stored sync checkpoint has an unsupported shape or version.");
  }
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$checkpoint.organizationId",
  );
  const cursor = decodeSyncCursor(record.value.cursor, "$checkpoint.cursor");
  const headResponse = decodePullEventsResponse({
    events: [],
    hasMore: false,
    nextCursor: record.value.cursor,
    head: record.value.head,
  });
  if (!organizationId.ok || !cursor.ok || !headResponse.ok) {
    throw new SyncRuntimeError("Stored sync checkpoint failed validation.");
  }
  if (headResponse.value.head.organizationId !== organizationId.value) {
    throw new SyncRuntimeError("Stored sync checkpoint crosses organization scope.");
  }
  return {
    cursor: cursor.value,
    organizationId: organizationId.value,
    schemaVersion: syncCheckpointVersion,
    head: headResponse.value.head,
  };
};

export const createSyncEngine = (
  input: Readonly<{
    organizationId: OrganizationId;
    storage: SyncStorage;
    transport: SyncTransport;
  }>,
) => {
  let checkpoint: SyncCheckpoint | null = null;
  let state: ProductSyncState = { cursor: null, status: "cached" };
  let syncPromise: Promise<void> | null = null;
  const listeners = new Set<(next: ProductSyncState) => void>();

  const publish = (next: ProductSyncState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const initialize = async (): Promise<void> => {
    const stored = await input.storage.load(input.organizationId);
    if (stored !== null) {
      const decoded = decodeSyncCheckpoint(stored);
      if (decoded.organizationId !== input.organizationId) {
        throw new SyncRuntimeError("Stored sync checkpoint belongs to another organization.");
      }
      checkpoint = decoded;
    }
    publish({ cursor: checkpoint?.cursor ?? null, status: "cached" });
  };

  const validatePage = (
    page: PullEventsResponse,
    appliedCursor: SyncCursor | null,
    expectedHeadCursor: SyncCursor | null,
  ): readonly ProductEvent[] => {
    if (page.head.organizationId !== input.organizationId) {
      throw new SyncRuntimeError("Sync response crosses organization scope.");
    }
    if (expectedHeadCursor !== null && page.head.cursor !== expectedHeadCursor) {
      throw new SyncRuntimeError("Stable sync head changed during pagination.");
    }
    if (appliedCursor !== null && compareCursor(page.nextCursor, appliedCursor) < 0) {
      throw new SyncRuntimeError("Sync response cursor regressed.");
    }
    for (const event of page.events) {
      if (event.organizationId !== input.organizationId) {
        throw new SyncRuntimeError("Sync event crosses organization scope.");
      }
      if (compareCursor(event.cursor, page.nextCursor) > 0) {
        throw new SyncRuntimeError("Sync event is ahead of its page cursor.");
      }
    }
    return page.events.filter(
      (event) => appliedCursor === null || compareCursor(event.cursor, appliedCursor) > 0,
    );
  };

  const runSync = async (): Promise<void> => {
    publish({ cursor: checkpoint?.cursor ?? null, status: "synchronizing" });
    let cursor = checkpoint?.cursor ?? null;
    let headCursor: SyncCursor | null = null;
    let pageCount = 0;
    try {
      while (true) {
        pageCount += 1;
        if (pageCount > 10_000) throw new SyncRuntimeError("Sync exceeded the page safety bound.");
        // Each request depends on the prior page's durable cursor.
        // eslint-disable-next-line no-await-in-loop
        const response = await input.transport.pull({
          after: cursor,
          limit: maxPullEvents,
          organizationId: input.organizationId,
          through: headCursor,
        });
        const decoded = decodePullEventsResponse(response, { after: cursor });
        if (!decoded.ok)
          throw new SyncRuntimeError("Sync response failed validation.", decoded.issues);
        const page = decoded.value;
        const events = validatePage(page, cursor, headCursor);
        headCursor ??= page.head.cursor;
        if (page.hasMore && cursor !== null && page.nextCursor === cursor) {
          throw new SyncRuntimeError("Sync page made no cursor progress.");
        }
        const nextCheckpoint: SyncCheckpoint = {
          cursor: page.nextCursor,
          organizationId: input.organizationId,
          schemaVersion: syncCheckpointVersion,
          head: page.head,
        };
        // The next page cannot be requested until this cursor is durable.
        // eslint-disable-next-line no-await-in-loop
        await input.storage.commit({ checkpoint: nextCheckpoint, events });
        checkpoint = nextCheckpoint;
        cursor = nextCheckpoint.cursor;
        publish({ cursor, status: "synchronizing" });
        if (!page.hasMore) {
          publish({ cursor, status: "live" });
          return;
        }
      }
    } catch (error) {
      publish({
        cursor: checkpoint?.cursor ?? null,
        error:
          error instanceof SyncRuntimeError ? error : new SyncRuntimeError("Sync failed.", error),
        status: "error",
      });
      throw error;
    }
  };

  const synchronize = (): Promise<void> => {
    syncPromise ??= runSync().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  };

  return {
    getState: (): ProductSyncState => state,
    initialize,
    subscribe(listener: (next: ProductSyncState) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    synchronize,
  };
};
