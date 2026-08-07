import {
  decodeOutboxEnvelope,
  type OutboxEnvelope,
  type OutboxStorage,
} from "@glass/client-runtime/outbox";
import {
  decodeSyncCheckpoint,
  type SyncCheckpoint,
  type SyncCommit,
  type SyncStorage,
} from "@glass/client-runtime/sync";
import { decodeId, type CommandId, type OrganizationId, type UserId } from "@glass/contracts/ids";
import type { ProductEvent } from "@glass/contracts/events";
import type { Organization, ProductEntity } from "@glass/contracts/product";
import type { ProductSnapshot } from "@glass/contracts/sync";
import { decodeProductSnapshot } from "@glass/contracts/sync";

const databaseName = "glass-product-cloud";
const storeName = "records";

export const productStorageScope = (userId: UserId, organizationId: OrganizationId): string =>
  `user:${userId}:organization:${organizationId}`;

export const productStorageKey = (
  userId: UserId,
  organizationId: OrganizationId,
  kind: "checkpoint" | "snapshot",
): string => `${productStorageScope(userId, organizationId)}:${kind}`;

export const outboxStorageKey = (
  userId: UserId,
  organizationId: OrganizationId,
  commandId: CommandId,
): string => `${productStorageScope(userId, organizationId)}:outbox:${commandId}`;

export const organizationBootstrapKey = (userId: UserId): string =>
  `user:${userId}:organization-bootstrap`;

const activeOrganizationStorageKey = (userId: UserId): string =>
  `glass:active-organization:${userId}`;

export const decodeActiveOrganizationPreference = (input: unknown): OrganizationId | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const decoded = decodeId<OrganizationId>(record.organizationId, "$activeOrganizationId");
  return decoded.ok ? decoded.value : null;
};

export const loadActiveOrganization = (userId: UserId): OrganizationId | null => {
  const raw = window.localStorage.getItem(activeOrganizationStorageKey(userId));
  if (raw === null) return null;
  try {
    const organizationId = decodeActiveOrganizationPreference(JSON.parse(raw) as unknown);
    if (organizationId !== null) return organizationId;
  } catch {
    // Invalid device preferences are discarded below.
  }
  window.localStorage.removeItem(activeOrganizationStorageKey(userId));
  return null;
};

export const saveActiveOrganization = (userId: UserId, organizationId: OrganizationId): void => {
  window.localStorage.setItem(
    activeOrganizationStorageKey(userId),
    JSON.stringify({ organizationId, schemaVersion: 1 }),
  );
};

export const clearActiveOrganization = (userId: UserId): void => {
  window.localStorage.removeItem(activeOrganizationStorageKey(userId));
};

const decodeOrganizationBootstrap = (input: unknown): OutboxEnvelope => {
  const envelope = decodeOutboxEnvelope(input);
  if (envelope.mutation.operation.kind !== "organization.create") {
    throw new Error("The organization bootstrap intent contains another command kind.");
  }
  return envelope;
};

const decodeStoredCheckpoint = (input: unknown): SyncCheckpoint | null => {
  try {
    return decodeSyncCheckpoint(input);
  } catch {
    return null;
  }
};

const requestResult = <Value>(request: IDBRequest<Value>): Promise<Value> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed.")),
      {
        once: true,
      },
    );
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
  });

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Could not open IndexedDB.")),
      { once: true },
    );
  });

export const saveOrganizationBootstrap = async (
  userId: UserId,
  envelope: OutboxEnvelope,
): Promise<void> => {
  const validated = decodeOrganizationBootstrap(envelope);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(validated, organizationBootstrapKey(userId));
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
};

export const loadOrganizationBootstrap = async (userId: UserId): Promise<OutboxEnvelope | null> => {
  const database = await openDatabase();
  try {
    const value = await requestResult(
      database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(organizationBootstrapKey(userId)),
    );
    return value === undefined ? null : decodeOrganizationBootstrap(value);
  } finally {
    database.close();
  }
};

const entityKey = (entity: ProductEntity): string =>
  "userId" in entity ? entity.userId : entity.id;

export const shouldPersistCursor = (
  current: ProductSnapshot["cursor"] | null,
  incoming: ProductSnapshot["cursor"],
): boolean => current === null || BigInt(current) <= BigInt(incoming);

export const mergeOrganizationBootstrap = (
  scoped: readonly unknown[],
  bootstrapValue: unknown,
  organizationId: OrganizationId,
): readonly unknown[] => {
  if (bootstrapValue === undefined) return scoped;
  const bootstrap = decodeOrganizationBootstrap(bootstrapValue);
  if (bootstrap.mutation.organizationId !== organizationId) return scoped;
  return scoped.some(
    (value) => decodeOutboxEnvelope(value).mutation.commandId === bootstrap.mutation.commandId,
  )
    ? scoped
    : [...scoped, bootstrap];
};

export const validateStoredProductState = (
  snapshotValue: unknown,
  checkpointValue: unknown,
  organizationId: OrganizationId,
): ProductSnapshot | null => {
  const decoded = decodeProductSnapshot(snapshotValue);
  const checkpoint = decodeStoredCheckpoint(checkpointValue);
  if (
    !decoded.ok ||
    checkpoint === null ||
    decoded.value.organization.id !== organizationId ||
    checkpoint.organizationId !== organizationId ||
    checkpoint.cursor !== decoded.value.cursor ||
    checkpoint.head.cursor !== decoded.value.cursor ||
    checkpoint.head.organizationId !== organizationId ||
    checkpoint.head.capturedAt !== decoded.value.capturedAt
  ) {
    return null;
  }
  return decoded.value;
};

const applyCollectionEvent = <Entity extends ProductEntity>(
  values: readonly Entity[],
  event: ProductEvent,
): readonly Entity[] => {
  const withoutCurrent = values.filter((value) => entityKey(value) !== event.aggregateId);
  return event.action === "deleted" || event.entity === null
    ? withoutCurrent
    : [...withoutCurrent, event.entity as Entity];
};

export const applyProductEvents = (
  snapshot: ProductSnapshot,
  events: readonly ProductEvent[],
  checkpoint: SyncCheckpoint,
): ProductSnapshot => {
  let organization = snapshot.organization;
  let members = snapshot.members;
  let projects = snapshot.projects;
  let threads = snapshot.threads;
  let messages = snapshot.messages;
  let artifacts = snapshot.artifacts;
  for (const event of events) {
    if (event.organizationId !== snapshot.organization.id) {
      throw new Error("Cannot apply an event from another organization.");
    }
    const current: ProductEntity | undefined =
      event.aggregateType === "organization"
        ? organization
        : event.aggregateType === "organization-member"
          ? members.find((member) => member.userId === event.aggregateId)
          : event.aggregateType === "project"
            ? projects.find((project) => project.id === event.aggregateId)
            : event.aggregateType === "thread"
              ? threads.find((thread) => thread.id === event.aggregateId)
              : event.aggregateType === "message"
                ? messages.find((message) => message.id === event.aggregateId)
                : artifacts.find((artifact) => artifact.id === event.aggregateId);
    if (current !== undefined && current.version >= event.aggregateVersion) continue;
    if (event.aggregateType === "organization") {
      if (event.entity !== null) organization = event.entity as Organization;
    } else if (event.aggregateType === "organization-member") {
      members = applyCollectionEvent(members, event);
    } else if (event.aggregateType === "project") {
      if (event.action === "deleted" || event.entity === null) {
        const removedThreadIds = new Set(
          threads
            .filter((thread) => thread.projectId === event.aggregateId)
            .map((thread) => thread.id),
        );
        artifacts = artifacts.filter((artifact) => artifact.projectId !== event.aggregateId);
        messages = messages.filter(
          (message) =>
            message.projectId !== event.aggregateId && !removedThreadIds.has(message.threadId),
        );
        projects = applyCollectionEvent(projects, event);
        threads = threads.filter((thread) => thread.projectId !== event.aggregateId);
      } else {
        projects = applyCollectionEvent(projects, event);
      }
    } else if (event.aggregateType === "thread") {
      if (event.action === "deleted" || event.entity === null) {
        messages = messages.filter((message) => message.threadId !== event.aggregateId);
        artifacts = artifacts.filter(
          (artifact) => !("threadId" in artifact && artifact.threadId === event.aggregateId),
        );
      }
      threads = applyCollectionEvent(threads, event);
    } else if (event.aggregateType === "message") {
      messages = applyCollectionEvent(messages, event);
    } else if (event.aggregateType === "artifact") {
      artifacts = applyCollectionEvent(artifacts, event);
    }
  }
  return {
    artifacts,
    capturedAt: checkpoint.head.capturedAt,
    cursor: checkpoint.cursor,
    members,
    messages,
    organization,
    projects,
    threads,
  };
};

export class IndexedDbProductStorage implements SyncStorage, OutboxStorage {
  readonly #organizationId: OrganizationId;
  readonly #scope: string;
  readonly #userId: UserId;
  readonly #snapshotListeners = new Set<(snapshot: ProductSnapshot) => void>();

  constructor(userId: UserId, organizationId: OrganizationId) {
    this.#userId = userId;
    this.#organizationId = organizationId;
    this.#scope = productStorageScope(userId, organizationId);
  }

  async loadSnapshot(): Promise<ProductSnapshot | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const [snapshotValue, checkpointValue] = await Promise.all([
        requestResult(store.get(productStorageKey(this.#userId, this.#organizationId, "snapshot"))),
        requestResult(
          store.get(productStorageKey(this.#userId, this.#organizationId, "checkpoint")),
        ),
      ]);
      if (snapshotValue === undefined && checkpointValue === undefined) return null;
      const validated = validateStoredProductState(
        snapshotValue,
        checkpointValue,
        this.#organizationId,
      );
      if (validated === null) {
        // UI cache is not authoritative. Remove an invalid record so a healthy
        // Glass Cloud connection can install a fresh, validated snapshot.
        const cleanup = database.transaction(storeName, "readwrite");
        const cleanupStore = cleanup.objectStore(storeName);
        cleanupStore.delete(productStorageKey(this.#userId, this.#organizationId, "snapshot"));
        cleanupStore.delete(productStorageKey(this.#userId, this.#organizationId, "checkpoint"));
        await transactionComplete(cleanup);
        return null;
      }
      return validated;
    } finally {
      database.close();
    }
  }

  async saveSnapshot(snapshot: ProductSnapshot): Promise<void> {
    if (snapshot.organization.id !== this.#organizationId) {
      throw new Error("Cannot store a snapshot from another organization.");
    }
    const checkpoint: SyncCheckpoint = {
      cursor: snapshot.cursor,
      organizationId: this.#organizationId,
      schemaVersion: 1,
      head: {
        capturedAt: snapshot.capturedAt,
        cursor: snapshot.cursor,
        organizationId: this.#organizationId,
      },
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const storedCheckpoint = decodeStoredCheckpoint(
        await requestResult(
          store.get(productStorageKey(this.#userId, this.#organizationId, "checkpoint")),
        ),
      );
      if (!shouldPersistCursor(storedCheckpoint?.cursor ?? null, snapshot.cursor)) {
        await transactionComplete(transaction);
        return;
      }
      store.put(snapshot, productStorageKey(this.#userId, this.#organizationId, "snapshot"));
      store.put(checkpoint, productStorageKey(this.#userId, this.#organizationId, "checkpoint"));
      await transactionComplete(transaction);
      this.#publishSnapshot(snapshot);
    } finally {
      database.close();
    }
  }

  load(): Promise<readonly unknown[]>;
  load(organizationId: OrganizationId): Promise<unknown | null>;
  async load(organizationId?: OrganizationId): Promise<unknown> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      if (organizationId !== undefined) {
        if (organizationId !== this.#organizationId) throw new Error("Checkpoint scope mismatch.");
        return (
          (await requestResult(
            store.get(productStorageKey(this.#userId, this.#organizationId, "checkpoint")),
          )) ?? null
        );
      }
      const prefix = `${this.#scope}:outbox:`;
      const [scoped, bootstrapValue] = await Promise.all([
        requestResult(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false))),
        requestResult(store.get(organizationBootstrapKey(this.#userId))),
      ]);
      return mergeOrganizationBootstrap(scoped, bootstrapValue, this.#organizationId);
    } finally {
      database.close();
    }
  }

  async commit(commit: SyncCommit): Promise<void> {
    if (commit.checkpoint.organizationId !== this.#organizationId) {
      throw new Error("Sync commit crossed organization scope.");
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const stored = await requestResult(
        store.get(productStorageKey(this.#userId, this.#organizationId, "snapshot")),
      );
      const decoded = decodeProductSnapshot(stored);
      if (!decoded.ok) {
        transaction.abort();
        throw new Error("Cannot apply sync events without a valid cached snapshot.");
      }
      if (!shouldPersistCursor(decoded.value.cursor, commit.checkpoint.cursor)) {
        await transactionComplete(transaction);
        return;
      }
      const next = applyProductEvents(decoded.value, commit.events, commit.checkpoint);
      store.put(next, productStorageKey(this.#userId, this.#organizationId, "snapshot"));
      store.put(
        commit.checkpoint,
        productStorageKey(this.#userId, this.#organizationId, "checkpoint"),
      );
      await transactionComplete(transaction);
      this.#publishSnapshot(next);
    } finally {
      database.close();
    }
  }

  async put(envelope: OutboxEnvelope): Promise<void> {
    if (envelope.mutation.organizationId !== this.#organizationId) {
      throw new Error("Outbox envelope scope mismatch.");
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      store.put(
        envelope,
        outboxStorageKey(this.#userId, this.#organizationId, envelope.mutation.commandId),
      );
      const bootstrapValue = await requestResult(store.get(organizationBootstrapKey(this.#userId)));
      if (
        bootstrapValue !== undefined &&
        decodeOrganizationBootstrap(bootstrapValue).mutation.commandId ===
          envelope.mutation.commandId
      ) {
        store.put(envelope, organizationBootstrapKey(this.#userId));
      }
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  async remove(commandId: CommandId): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      store.delete(outboxStorageKey(this.#userId, this.#organizationId, commandId));
      const bootstrapValue = await requestResult(store.get(organizationBootstrapKey(this.#userId)));
      if (
        bootstrapValue !== undefined &&
        decodeOrganizationBootstrap(bootstrapValue).mutation.commandId === commandId
      ) {
        store.delete(organizationBootstrapKey(this.#userId));
      }
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  subscribeSnapshot(listener: (snapshot: ProductSnapshot) => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  #publishSnapshot(snapshot: ProductSnapshot): void {
    for (const listener of this.#snapshotListeners) listener(snapshot);
  }
}
