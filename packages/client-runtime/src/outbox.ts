import type { CommandId, IsoDateTime, OrganizationId } from "@glass/contracts/ids";
import { decodeIsoDateTime } from "@glass/contracts/ids";
import type { ProductMutation } from "@glass/contracts/events";
import { decodeProductMutation } from "@glass/contracts/events";
import type { PushCommandsRequest } from "@glass/contracts/sync";
import { decodePushCommandsResponse } from "@glass/contracts/sync";
import { decodeInteger, decodeRecord } from "@glass/contracts/validation";

export const outboxEnvelopeVersion = 1 as const;
export const maximumRetryDelayMs = 16_000 as const;

export type PermanentCommandFailureCode =
  | "conflict"
  | "forbidden"
  | "invalid"
  | "not-found"
  | "unauthenticated";

export type OutboxAttention = Readonly<{
  code: PermanentCommandFailureCode | "protocol";
  currentVersion: number | null;
  message: string;
}>;

export type OutboxEnvelope = Readonly<{
  attemptCount: number;
  attention: OutboxAttention | null;
  enqueuedAt: IsoDateTime;
  mutation: ProductMutation;
  nextAttemptAt: number | null;
  schemaVersion: typeof outboxEnvelopeVersion;
  status: "needs-attention" | "queued" | "sending";
}>;

export interface OutboxStorage {
  /** Stored values cross a persistence boundary and are decoded by the engine. */
  load(): Promise<readonly unknown[]>;
  put(envelope: OutboxEnvelope): Promise<void>;
  remove(commandId: CommandId): Promise<void>;
}

export interface OutboxTransport {
  /** Sends Glass product commands only. Editor operations have their own library-owned runtime. */
  push(request: PushCommandsRequest): Promise<unknown>;
}

export interface RuntimeClock {
  now(): number;
}

export interface RuntimeRandom {
  /** Returns a value in the half-open range [0, 1). */
  next(): number;
}

export interface OutboxScheduler {
  schedule(delayMs: number, task: () => void): () => void;
}

export type TransportFailure =
  | Readonly<{ kind: "transient" }>
  | Readonly<{
      code: PermanentCommandFailureCode;
      currentVersion: number | null;
      kind: "permanent";
      message: string;
    }>;

export type OutboxEngineOptions = Readonly<{
  classifyTransportError: (error: unknown) => TransportFailure;
  clock: RuntimeClock;
  onAccepted?: (commandId: CommandId) => void;
  random: RuntimeRandom;
  scheduler?: OutboxScheduler;
  storage: OutboxStorage;
  transport: OutboxTransport;
}>;

export class OutboxValidationError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = "OutboxValidationError";
    this.causeValue = causeValue;
  }
}

const isoNow = (clock: RuntimeClock): IsoDateTime =>
  new Date(clock.now()).toISOString() as IsoDateTime;

const decodeAttention = (input: unknown): OutboxAttention | null | undefined => {
  if (input === null) return null;
  const record = decodeRecord(input, "$outbox.attention");
  if (!record.ok) return undefined;
  if (
    Object.keys(record.value).some(
      (key) => key !== "code" && key !== "currentVersion" && key !== "message",
    )
  ) {
    return undefined;
  }
  const code = record.value.code;
  if (
    code !== "conflict" &&
    code !== "forbidden" &&
    code !== "invalid" &&
    code !== "not-found" &&
    code !== "unauthenticated" &&
    code !== "protocol"
  ) {
    return undefined;
  }
  if (typeof record.value.message !== "string" || record.value.message.length === 0) {
    return undefined;
  }
  const currentVersion = record.value.currentVersion;
  if (
    currentVersion !== null &&
    (!Number.isSafeInteger(currentVersion) || (currentVersion as number) < 1)
  ) {
    return undefined;
  }
  return { code, currentVersion: currentVersion as number | null, message: record.value.message };
};

export const decodeOutboxEnvelope = (input: unknown): OutboxEnvelope => {
  const record = decodeRecord(input, "$outbox");
  if (!record.ok) throw new OutboxValidationError("Stored outbox envelope is not an object.");
  const envelopeFields = new Set([
    "attemptCount",
    "attention",
    "enqueuedAt",
    "mutation",
    "nextAttemptAt",
    "schemaVersion",
    "status",
  ]);
  if (Object.keys(record.value).some((key) => !envelopeFields.has(key))) {
    throw new OutboxValidationError("Stored outbox envelope contains an unknown field.");
  }
  if (record.value.schemaVersion !== outboxEnvelopeVersion) {
    throw new OutboxValidationError("Stored outbox envelope has an unsupported schema version.");
  }
  const mutation = decodeProductMutation(record.value.mutation, "$outbox.mutation");
  const enqueuedAt = decodeIsoDateTime(record.value.enqueuedAt, "$outbox.enqueuedAt");
  const attemptCount = decodeInteger(record.value.attemptCount, "$outbox.attemptCount", {
    min: 0,
  });
  const nextAttemptAt =
    record.value.nextAttemptAt === null
      ? null
      : decodeInteger(record.value.nextAttemptAt, "$outbox.nextAttemptAt", { min: 0 });
  const status = record.value.status;
  const attention = decodeAttention(record.value.attention);
  if (
    !mutation.ok ||
    !enqueuedAt.ok ||
    !attemptCount.ok ||
    (nextAttemptAt !== null && !nextAttemptAt.ok) ||
    (status !== "queued" && status !== "sending" && status !== "needs-attention") ||
    attention === undefined ||
    (status === "needs-attention" ? attention === null : attention !== null)
  ) {
    throw new OutboxValidationError("Stored outbox envelope failed validation.");
  }
  return {
    attemptCount: attemptCount.value,
    attention,
    enqueuedAt: enqueuedAt.value,
    mutation: mutation.value,
    nextAttemptAt: nextAttemptAt === null ? null : nextAttemptAt.value,
    schemaVersion: outboxEnvelopeVersion,
    status,
  };
};

export const retryDelayMs = (attemptCount: number, random: RuntimeRandom): number => {
  const exponent = Math.max(0, attemptCount - 1);
  const base = Math.min(maximumRetryDelayMs, 1_000 * 2 ** exponent);
  const sample = random.next();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new OutboxValidationError("Random source returned a value outside [0, 1).", sample);
  }
  return Math.floor(Math.min(maximumRetryDelayMs, base * (0.5 + sample)));
};

const compareEnvelope = (left: OutboxEnvelope, right: OutboxEnvelope): number => {
  const timestamp = left.enqueuedAt.localeCompare(right.enqueuedAt);
  return timestamp === 0
    ? left.mutation.commandId.localeCompare(right.mutation.commandId)
    : timestamp;
};

const protocolAttention = (message: string): OutboxAttention => ({
  code: "protocol",
  currentVersion: null,
  message,
});

export const createOutboxEngine = (options: OutboxEngineOptions) => {
  let envelopes: readonly OutboxEnvelope[] = [];
  let mutationQueue = Promise.resolve();
  let drainPromise: Promise<void> | null = null;
  let cancelScheduledDrain: (() => void) | null = null;
  let disposed = false;
  const listeners = new Set<(items: readonly OutboxEnvelope[]) => void>();

  const assertActive = (): void => {
    if (disposed) throw new OutboxValidationError("The outbox engine has been disposed.");
  };

  const scheduler: OutboxScheduler =
    options.scheduler ??
    ({
      schedule: (delayMs, task) => {
        const timer = setTimeout(task, delayMs);
        return () => clearTimeout(timer);
      },
    } satisfies OutboxScheduler);

  const publish = () => {
    const snapshot = [...envelopes].sort(compareEnvelope);
    for (const listener of listeners) listener(snapshot);
  };

  const serialize = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const replace = (envelope: OutboxEnvelope) => {
    envelopes = [
      ...envelopes.filter(
        (candidate) => candidate.mutation.commandId !== envelope.mutation.commandId,
      ),
      envelope,
    ];
    publish();
  };

  const initialize = (): Promise<void> =>
    serialize(async () => {
      assertActive();
      const stored = (await options.storage.load()).map(decodeOutboxEnvelope);
      const recovered: OutboxEnvelope[] = [];
      for (const envelope of stored) {
        if (envelope.status === "sending") {
          const queued = { ...envelope, status: "queued" as const };
          // Recovery writes are ordered with every other outbox mutation.
          // eslint-disable-next-line no-await-in-loop
          await options.storage.put(queued);
          recovered.push(queued);
        } else {
          recovered.push(envelope);
        }
      }
      const byCommand = new Map<CommandId, OutboxEnvelope>();
      for (const envelope of [...recovered, ...envelopes].sort(compareEnvelope)) {
        const existing = byCommand.get(envelope.mutation.commandId);
        if (
          existing !== undefined &&
          JSON.stringify(existing.mutation) !== JSON.stringify(envelope.mutation)
        ) {
          throw new OutboxValidationError(
            "Stored outbox contains one command identifier with different mutations.",
            envelope.mutation.commandId,
          );
        }
        byCommand.set(envelope.mutation.commandId, envelope);
      }
      envelopes = [...byCommand.values()];
      publish();
    });

  const enqueue = (mutation: ProductMutation): Promise<OutboxEnvelope> =>
    serialize(async () => {
      assertActive();
      const validated = decodeProductMutation(mutation);
      if (!validated.ok)
        throw new OutboxValidationError("Mutation failed validation.", validated.issues);
      const existing = envelopes.find(
        (candidate) => candidate.mutation.commandId === mutation.commandId,
      );
      if (existing !== undefined) {
        if (JSON.stringify(existing.mutation) !== JSON.stringify(validated.value)) {
          throw new OutboxValidationError(
            "Command identifier is already queued with a different mutation.",
            mutation.commandId,
          );
        }
        return existing;
      }
      const envelope: OutboxEnvelope = {
        attemptCount: 0,
        attention: null,
        enqueuedAt: isoNow(options.clock),
        mutation: validated.value,
        nextAttemptAt: null,
        schemaVersion: outboxEnvelopeVersion,
        status: "queued",
      };
      // Memory is changed only after the durable write succeeds.
      await options.storage.put(envelope);
      replace(envelope);
      return envelope;
    });

  const setNeedsAttention = async (
    envelope: OutboxEnvelope,
    attention: OutboxAttention,
  ): Promise<void> => {
    const next = {
      ...envelope,
      attention,
      nextAttemptAt: null,
      status: "needs-attention" as const,
    };
    try {
      await options.storage.put(next);
      replace(next);
    } catch (error) {
      // The durable value is still `sending`. Keep this live engine recoverable too; a process
      // restart performs the same sending-to-queued recovery from durable storage.
      replace({ ...envelope, attention: null, nextAttemptAt: null, status: "queued" });
      throw error;
    }
  };

  const finalizeResult = (envelope: OutboxEnvelope): Promise<void> =>
    serialize(async () => {
      // A failed local delete deliberately leaves the item available for an
      // idempotent replay of the authoritative command receipt.
      try {
        await options.storage.remove(envelope.mutation.commandId);
        envelopes = envelopes.filter(
          (candidate) => candidate.mutation.commandId !== envelope.mutation.commandId,
        );
        publish();
      } catch (error) {
        replace({ ...envelope, status: "queued", attention: null, nextAttemptAt: null });
        throw error;
      }
    });

  const deliver = async (selected: OutboxEnvelope): Promise<void> => {
    const sending = await serialize(async () => {
      const current = envelopes.find(
        (candidate) => candidate.mutation.commandId === selected.mutation.commandId,
      );
      if (current?.status !== "queued") return null;
      const next = { ...current, status: "sending" as const };
      await options.storage.put(next);
      replace(next);
      return next;
    });
    if (sending === null) return;

    let response: unknown;
    try {
      response = await options.transport.push({
        commands: [sending.mutation],
        organizationId: sending.mutation.organizationId,
      });
    } catch (error) {
      await serialize(async () => {
        const failure = options.classifyTransportError(error);
        if (failure.kind === "transient") {
          const attemptCount = sending.attemptCount + 1;
          const queued = {
            ...sending,
            attemptCount,
            attention: null,
            nextAttemptAt: options.clock.now() + retryDelayMs(attemptCount, options.random),
            status: "queued" as const,
          };
          try {
            await options.storage.put(queued);
            replace(queued);
          } catch (storageError) {
            replace({ ...sending, attention: null, nextAttemptAt: null, status: "queued" });
            throw storageError;
          }
          return;
        }
        await setNeedsAttention(sending, {
          code: failure.code,
          currentVersion: failure.currentVersion,
          message: failure.message,
        });
      });
      return;
    }

    const decoded = decodePushCommandsResponse(response);
    if (!decoded.ok) {
      await serialize(() =>
        setNeedsAttention(sending, protocolAttention("Invalid push response.")),
      );
      return;
    }
    const result = decoded.value.results[0];
    if (decoded.value.results.length !== 1 || result?.commandId !== sending.mutation.commandId) {
      await serialize(() =>
        setNeedsAttention(
          sending,
          protocolAttention("Push response did not contain exactly the requested command receipt."),
        ),
      );
      return;
    }
    await finalizeResult(sending);
    options.onAccepted?.(sending.mutation.commandId);
  };

  const findReadyHead = (): OutboxEnvelope | null => {
    const heads = new Map<OrganizationId, OutboxEnvelope>();
    for (const envelope of [...envelopes].sort(compareEnvelope)) {
      if (!heads.has(envelope.mutation.organizationId)) {
        heads.set(envelope.mutation.organizationId, envelope);
      }
    }
    return (
      [...heads.values()]
        .filter(
          (envelope) =>
            envelope.status === "queued" &&
            (envelope.nextAttemptAt === null || envelope.nextAttemptAt <= options.clock.now()),
        )
        .sort(compareEnvelope)[0] ?? null
    );
  };

  const scheduleNextDrain = (): void => {
    if (disposed || cancelScheduledDrain !== null) return;
    const organizationHeads = new Map<OrganizationId, OutboxEnvelope>();
    for (const envelope of [...envelopes].sort(compareEnvelope)) {
      if (!organizationHeads.has(envelope.mutation.organizationId)) {
        organizationHeads.set(envelope.mutation.organizationId, envelope);
      }
    }
    const nextAttemptAt = [...organizationHeads.values()]
      .filter(
        (envelope) =>
          envelope.status === "queued" &&
          envelope.nextAttemptAt !== null &&
          envelope.nextAttemptAt > options.clock.now(),
      )
      .map((envelope) => envelope.nextAttemptAt as number)
      .sort((left, right) => left - right)[0];
    if (nextAttemptAt === undefined) return;
    cancelScheduledDrain = scheduler.schedule(
      Math.max(0, nextAttemptAt - options.clock.now()),
      () => {
        cancelScheduledDrain = null;
        if (disposed) return;
        void drain().catch(() => {
          // A durable storage failure is surfaced by explicit drain callers. The scheduler
          // deliberately avoids an unbounded immediate loop when local persistence is unavailable.
        });
      },
    );
  };

  const drain = (): Promise<void> => {
    if (disposed)
      return Promise.reject(new OutboxValidationError("The outbox engine has been disposed."));
    if (drainPromise !== null) return drainPromise;
    cancelScheduledDrain?.();
    cancelScheduledDrain = null;
    drainPromise = (async () => {
      while (true) {
        if (disposed) return;
        // Delivery is deliberately sequential: this is the FIFO scheduler.
        // eslint-disable-next-line no-await-in-loop
        const next = await serialize(async () => findReadyHead());
        if (next === null) return;
        // eslint-disable-next-line no-await-in-loop
        await deliver(next);
        if (disposed) return;
      }
    })().finally(() => {
      drainPromise = null;
      scheduleNextDrain();
    });
    return drainPromise;
  };

  const retry = (commandId: CommandId): Promise<void> =>
    serialize(async () => {
      assertActive();
      const current = envelopes.find((item) => item.mutation.commandId === commandId);
      if (current?.status !== "needs-attention") return;
      if (
        current.attention?.code === "conflict" ||
        current.attention?.code === "invalid" ||
        current.attention?.code === "protocol"
      ) {
        throw new OutboxValidationError(
          "This command cannot succeed unchanged; discard or replace it instead of retrying.",
          commandId,
        );
      }
      const queued = {
        ...current,
        attention: null,
        nextAttemptAt: null,
        status: "queued" as const,
      };
      await options.storage.put(queued);
      replace(queued);
    });

  const discard = (commandId: CommandId): Promise<void> =>
    serialize(async () => {
      assertActive();
      const current = envelopes.find((item) => item.mutation.commandId === commandId);
      if (current === undefined) return;
      if (current.status !== "needs-attention") {
        throw new OutboxValidationError(
          "Only an outbox command that needs attention can be discarded.",
          commandId,
        );
      }
      await options.storage.remove(commandId);
      envelopes = envelopes.filter((item) => item.mutation.commandId !== commandId);
      publish();
    });

  return {
    discard,
    dispose: (): void => {
      disposed = true;
      cancelScheduledDrain?.();
      cancelScheduledDrain = null;
      listeners.clear();
    },
    drain,
    enqueue,
    getSnapshot: (): readonly OutboxEnvelope[] => [...envelopes].sort(compareEnvelope),
    initialize,
    retry,
    subscribe(listener: (items: readonly OutboxEnvelope[]) => void): () => void {
      listeners.add(listener);
      listener([...envelopes].sort(compareEnvelope));
      return () => listeners.delete(listener);
    },
  };
};
