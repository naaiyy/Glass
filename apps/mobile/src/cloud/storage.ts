import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  decodeOutboxEnvelope,
  type OutboxEnvelope,
  type OutboxStorage,
} from "@glass/client-runtime/outbox";
import {
  decodeSyncCheckpoint,
  syncCheckpointVersion,
  type SyncCheckpoint,
  type SyncCommit,
  type SyncStorage,
} from "@glass/client-runtime/sync";
import type { ProductEvent } from "@glass/contracts/events";
import type { OrganizationId, UserId } from "@glass/contracts/ids";
import type {
  Artifact,
  Message,
  OrganizationMember,
  ProductEntity,
  Project,
  Thread,
} from "@glass/contracts/product";
import { decodeProductSnapshot, type ProductSnapshot } from "@glass/contracts/sync";
import { decodeId } from "@glass/contracts/ids";
import { decodeRecord } from "@glass/contracts/validation";

import {
  activeOrganizationKey,
  organizationBootstrapKey,
  outboxKey,
  productCacheKey,
  type MobileCloudScope,
} from "./storage-keys.ts";

const mobileCacheVersion = 1 as const;
const persistenceQueues = new Map<string, Promise<void>>();

type StoredProductCache = Readonly<{
  checkpoint: SyncCheckpoint;
  schemaVersion: typeof mobileCacheVersion;
  snapshot: ProductSnapshot;
}>;

const parseStoredJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(`${label} contains invalid JSON.`, { cause });
  }
};

const decodeOrganizationBootstrap = (input: unknown): OutboxEnvelope => {
  const envelope = decodeOutboxEnvelope(input);
  if (envelope.mutation.operation.kind !== "organization.create") {
    throw new Error("The organization bootstrap intent contains another command kind.");
  }
  return envelope;
};

const decodeStoredProductCache = (input: unknown): StoredProductCache => {
  const record = decodeRecord(input, "$mobileCache");
  if (!record.ok || record.value.schemaVersion !== mobileCacheVersion) {
    throw new Error("The mobile product cache has an unsupported shape or version.");
  }
  const snapshot = decodeProductSnapshot(record.value.snapshot);
  if (!snapshot.ok) throw new Error("The mobile product snapshot failed validation.");
  const checkpoint = decodeSyncCheckpoint(record.value.checkpoint);
  if (
    checkpoint.organizationId !== snapshot.value.organization.id ||
    checkpoint.cursor !== snapshot.value.cursor
  ) {
    throw new Error("The mobile product cache checkpoint does not match its snapshot.");
  }
  return { schemaVersion: mobileCacheVersion, snapshot: snapshot.value, checkpoint };
};

const serializePersistence = async (key: string, operation: () => Promise<void>): Promise<void> => {
  const prior = persistenceQueues.get(key) ?? Promise.resolve();
  const next = prior.then(operation, operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  persistenceQueues.set(key, settled);
  try {
    await next;
  } finally {
    if (persistenceQueues.get(key) === settled) persistenceQueues.delete(key);
  }
};

const entityId = (entity: ProductEntity): string => ("id" in entity ? entity.id : entity.userId);

const replaceById = <Entity extends ProductEntity>(
  values: readonly Entity[],
  entity: Entity,
): readonly Entity[] => [...values.filter((value) => entityId(value) !== entityId(entity)), entity];

const removeByAggregateId = <Entity extends ProductEntity>(
  values: readonly Entity[],
  aggregateId: string,
): readonly Entity[] => values.filter((value) => entityId(value) !== aggregateId);

const aggregateVersion = (snapshot: ProductSnapshot, event: ProductEvent): number | undefined => {
  switch (event.aggregateType) {
    case "organization":
      return snapshot.organization.id === event.aggregateId
        ? snapshot.organization.version
        : undefined;
    case "organization-member":
      return snapshot.members.find((item) => item.userId === event.aggregateId)?.version;
    case "project":
      return snapshot.projects.find((item) => item.id === event.aggregateId)?.version;
    case "thread":
      return snapshot.threads.find((item) => item.id === event.aggregateId)?.version;
    case "message":
      return snapshot.messages.find((item) => item.id === event.aggregateId)?.version;
    case "artifact":
      return snapshot.artifacts.find((item) => item.id === event.aggregateId)?.version;
  }
};

const applyProductEvent = (snapshot: ProductSnapshot, event: ProductEvent): ProductSnapshot => {
  const currentVersion = aggregateVersion(snapshot, event);
  if (currentVersion !== undefined && event.aggregateVersion <= currentVersion) {
    return snapshot;
  }
  const remove = event.action === "deleted" || event.entity === null;
  const next = { ...snapshot, cursor: event.cursor, capturedAt: event.occurredAt };
  switch (event.aggregateType) {
    case "organization":
      return remove || event.entity === null
        ? next
        : { ...next, organization: event.entity as ProductSnapshot["organization"] };
    case "organization-member":
      return {
        ...next,
        members: remove
          ? removeByAggregateId(snapshot.members, event.aggregateId)
          : replaceById(snapshot.members, event.entity as OrganizationMember),
      };
    case "project":
      if (remove) {
        const removedThreadIds = new Set(
          snapshot.threads
            .filter((thread) => thread.projectId === event.aggregateId)
            .map((thread) => thread.id),
        );
        return {
          ...next,
          artifacts: snapshot.artifacts.filter(
            (artifact) => artifact.projectId !== event.aggregateId,
          ),
          messages: snapshot.messages.filter(
            (message) =>
              message.projectId !== event.aggregateId && !removedThreadIds.has(message.threadId),
          ),
          projects: removeByAggregateId(snapshot.projects, event.aggregateId),
          threads: snapshot.threads.filter((thread) => thread.projectId !== event.aggregateId),
        };
      }
      return {
        ...next,
        projects: replaceById(snapshot.projects, event.entity as Project),
      };
    case "thread":
      if (remove) {
        return {
          ...next,
          artifacts: snapshot.artifacts.filter(
            (artifact) => !("threadId" in artifact && artifact.threadId === event.aggregateId),
          ),
          messages: snapshot.messages.filter((message) => message.threadId !== event.aggregateId),
          threads: removeByAggregateId(snapshot.threads, event.aggregateId),
        };
      }
      return {
        ...next,
        threads: replaceById(snapshot.threads, event.entity as Thread),
      };
    case "message":
      return {
        ...next,
        messages: remove
          ? removeByAggregateId(snapshot.messages, event.aggregateId)
          : replaceById(snapshot.messages, event.entity as Message),
      };
    case "artifact":
      return {
        ...next,
        artifacts: remove
          ? removeByAggregateId(snapshot.artifacts, event.aggregateId)
          : replaceById(snapshot.artifacts, event.entity as Artifact),
      };
  }
};

export const applyProductEvents = (
  snapshot: ProductSnapshot,
  events: readonly ProductEvent[],
): ProductSnapshot => events.reduce(applyProductEvent, snapshot);

const applyCommit = (snapshot: ProductSnapshot, commit: SyncCommit): ProductSnapshot => {
  const projected = applyProductEvents(snapshot, commit.events);
  return {
    ...projected,
    cursor: commit.checkpoint.cursor,
    capturedAt: commit.checkpoint.head.capturedAt,
  };
};

export const loadActiveOrganization = async (userId: UserId): Promise<OrganizationId | null> => {
  const stored = await AsyncStorage.getItem(activeOrganizationKey(userId));
  if (stored === null) return null;
  const decoded = decodeId<OrganizationId>(stored, "$activeOrganization");
  if (!decoded.ok) {
    await AsyncStorage.removeItem(activeOrganizationKey(userId));
    return null;
  }
  return decoded.value;
};

export const saveActiveOrganization = (
  userId: UserId,
  organizationId: OrganizationId,
): Promise<void> => AsyncStorage.setItem(activeOrganizationKey(userId), organizationId);

export const clearActiveOrganization = (userId: UserId): Promise<void> =>
  AsyncStorage.removeItem(activeOrganizationKey(userId));

export const saveOrganizationBootstrap = (
  userId: UserId,
  envelope: OutboxEnvelope,
): Promise<void> =>
  AsyncStorage.setItem(
    organizationBootstrapKey(userId),
    JSON.stringify(decodeOrganizationBootstrap(envelope)),
  );

export const loadOrganizationBootstrap = async (userId: UserId): Promise<OutboxEnvelope | null> => {
  const stored = await AsyncStorage.getItem(organizationBootstrapKey(userId));
  return stored === null
    ? null
    : decodeOrganizationBootstrap(parseStoredJson(stored, "Organization bootstrap intent"));
};

export const createMobileProductStorage = (
  scope: MobileCloudScope,
  onSnapshot: (snapshot: ProductSnapshot) => void,
) => {
  const key = productCacheKey(scope);

  const loadCache = async (): Promise<StoredProductCache | null> => {
    const stored = await AsyncStorage.getItem(key);
    if (stored === null) return null;
    try {
      return decodeStoredProductCache(parseStoredJson(stored, "Product cache"));
    } catch {
      // UI cache is not authoritative. Invalid cache must not prevent a fresh
      // snapshot from being requested from authenticated Glass Cloud.
      await AsyncStorage.removeItem(key);
      return null;
    }
  };

  const persist = async (snapshot: ProductSnapshot, checkpoint: SyncCheckpoint): Promise<void> => {
    await serializePersistence(key, async () => {
      const current = await loadCache();
      if (current !== null && BigInt(current.snapshot.cursor) > BigInt(snapshot.cursor)) return;
      const value: StoredProductCache = {
        checkpoint,
        schemaVersion: mobileCacheVersion,
        snapshot,
      };
      await AsyncStorage.setItem(key, JSON.stringify(value));
      onSnapshot(snapshot);
    });
  };

  const installSnapshot = async (snapshot: ProductSnapshot): Promise<void> => {
    if (snapshot.organization.id !== scope.organizationId) {
      throw new Error("The product snapshot crosses the selected organization scope.");
    }
    await persist(snapshot, {
      cursor: snapshot.cursor,
      organizationId: scope.organizationId,
      schemaVersion: syncCheckpointVersion,
      head: {
        capturedAt: snapshot.capturedAt,
        cursor: snapshot.cursor,
        organizationId: scope.organizationId,
      },
    });
  };

  const syncStorage: SyncStorage = {
    load: async (organizationId) => {
      if (organizationId !== scope.organizationId) {
        throw new Error("Sync storage was opened for a different organization.");
      }
      return (await loadCache())?.checkpoint ?? null;
    },
    commit: async (commit) => {
      if (commit.checkpoint.organizationId !== scope.organizationId) {
        throw new Error("Sync commit crosses the selected organization scope.");
      }
      const current = await loadCache();
      if (current === null) throw new Error("A product snapshot is required before event sync.");
      await persist(applyCommit(current.snapshot, commit), commit.checkpoint);
    },
  };

  return {
    installSnapshot,
    loadSnapshot: async (): Promise<ProductSnapshot | null> =>
      (await loadCache())?.snapshot ?? null,
    syncStorage,
  };
};

export const createMobileOutboxStorage = (scope: MobileCloudScope): OutboxStorage => {
  const key = outboxKey(scope);

  const load = async (): Promise<readonly unknown[]> => {
    const stored = await AsyncStorage.getItem(key);
    const parsed = stored === null ? [] : parseStoredJson(stored, "Product outbox");
    if (!Array.isArray(parsed)) throw new Error("The product outbox failed validation.");
    const bootstrap = await loadOrganizationBootstrap(scope.userId);
    if (
      bootstrap === null ||
      bootstrap.mutation.organizationId !== scope.organizationId ||
      parsed.some(
        (candidate) =>
          decodeOutboxEnvelope(candidate).mutation.commandId === bootstrap.mutation.commandId,
      )
    ) {
      return parsed;
    }
    return [...parsed, bootstrap];
  };

  return {
    load,
    put: async (envelope: OutboxEnvelope) => {
      if (envelope.mutation.organizationId !== scope.organizationId) {
        throw new Error("Outbox mutation crosses the selected organization scope.");
      }
      const current = await load();
      const next = [
        ...current.filter((candidate) => {
          try {
            return (
              decodeOutboxEnvelope(candidate).mutation.commandId !== envelope.mutation.commandId
            );
          } catch {
            return true;
          }
        }),
        envelope,
      ];
      await AsyncStorage.setItem(key, JSON.stringify(next));
      const bootstrap = await loadOrganizationBootstrap(scope.userId);
      if (bootstrap?.mutation.commandId === envelope.mutation.commandId) {
        await saveOrganizationBootstrap(scope.userId, envelope);
      }
    },
    remove: async (commandId) => {
      const current = await load();
      const next = current.filter((candidate) => {
        const record = decodeRecord(candidate, "$outboxItem");
        if (!record.ok) return true;
        const mutation = decodeRecord(record.value.mutation, "$outboxItem.mutation");
        return !mutation.ok || mutation.value.commandId !== commandId;
      });
      await AsyncStorage.setItem(key, JSON.stringify(next));
      const bootstrap = await loadOrganizationBootstrap(scope.userId);
      if (bootstrap?.mutation.commandId === commandId) {
        await AsyncStorage.removeItem(organizationBootstrapKey(scope.userId));
      }
    },
  };
};
