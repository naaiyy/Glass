import type { CommandId, OrganizationId, SyncCursor } from "@glass/contracts/ids";
import type { ProductMutation } from "@glass/contracts/events";
import { describe, expect, it } from "vite-plus/test";

import {
  createOutboxEngine,
  maximumRetryDelayMs,
  type OutboxEnvelope,
  type OutboxStorage,
} from "./outbox.ts";

const organizationId = "00000000-0000-4000-8000-000000000001" as OrganizationId;
const commandId = "00000000-0000-4000-8000-000000000002" as CommandId;
const acceptedCursor = "1" as SyncCursor;

const mutation = (id = commandId): ProductMutation => ({
  commandId: id,
  operation: { kind: "organization.create", name: "Glass" },
  organizationId,
});

const memoryStorage = () => {
  const values = new Map<CommandId, OutboxEnvelope>();
  const storage: OutboxStorage = {
    load: async () => [...values.values()],
    put: async (envelope) => {
      values.set(envelope.mutation.commandId, envelope);
    },
    remove: async (id) => {
      values.delete(id);
    },
  };
  return { storage, values };
};

const accepted = (id = commandId) => ({
  results: [{ commandId: id, cursor: acceptedCursor, eventCount: 1, status: "accepted" }],
});

describe("durable mutation outbox", () => {
  it("does not publish or send an enqueue whose durable write fails", async () => {
    let pushCount = 0;
    const engine = createOutboxEngine({
      classifyTransportError: () => ({
        kind: "permanent",
        code: "invalid",
        currentVersion: null,
        message: "Storage unavailable.",
      }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage: {
        load: async () => [],
        put: async () => {
          throw new Error("disk full");
        },
        remove: async () => undefined,
      },
      transport: {
        push: async () => {
          pushCount += 1;
          return accepted();
        },
      },
    });

    await expect(engine.enqueue(mutation())).rejects.toThrow("disk full");
    await engine.drain();

    expect(engine.getSnapshot()).toEqual([]);
    expect(pushCount).toBe(0);
  });

  it("rejects reuse of a queued command identifier with a different payload", async () => {
    const { storage } = memoryStorage();
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: { push: async () => accepted() },
    });
    await engine.enqueue(mutation());

    await expect(
      engine.enqueue({
        ...mutation(),
        operation: { kind: "organization.create", name: "Different" },
      }),
    ).rejects.toThrow("already queued with a different mutation");
    expect(engine.getSnapshot()).toHaveLength(1);
    engine.dispose();
  });

  it("rejects conflicting duplicate command identifiers recovered from storage", async () => {
    const first: OutboxEnvelope = {
      attemptCount: 0,
      attention: null,
      enqueuedAt: "2026-08-02T10:00:00.000Z" as never,
      mutation: mutation(),
      nextAttemptAt: null,
      schemaVersion: 1,
      status: "queued",
    };
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage: {
        load: async () => [
          first,
          {
            ...first,
            mutation: {
              ...first.mutation,
              operation: { kind: "organization.create", name: "Different" },
            },
          },
        ],
        put: async () => undefined,
        remove: async () => undefined,
      },
      transport: { push: async () => accepted() },
    });

    await expect(engine.initialize()).rejects.toThrow("different mutations");
    engine.dispose();
  });

  it("replays the stable command after cloud commit but local delete failure", async () => {
    const { storage, values } = memoryStorage();
    let removeAttempts = 0;
    let pushCount = 0;
    const acceptedCommands: CommandId[] = [];
    storage.remove = async (id) => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw new Error("local delete failed");
      values.delete(id);
    };
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      onAccepted: (acceptedCommandId) => acceptedCommands.push(acceptedCommandId),
      random: { next: () => 0.5 },
      storage,
      transport: {
        push: async (request) => {
          pushCount += 1;
          expect(request.commands[0]?.commandId).toBe(commandId);
          return accepted();
        },
      },
    });

    await engine.enqueue(mutation());
    await expect(engine.drain()).rejects.toThrow("local delete failed");
    expect(engine.getSnapshot()[0]?.status).toBe("queued");
    expect(acceptedCommands).toEqual([]);

    await engine.drain();
    expect(pushCount).toBe(2);
    expect(acceptedCommands).toEqual([commandId]);
    expect(engine.getSnapshot()).toEqual([]);
    expect(values.size).toBe(0);
  });

  it("keeps a sent command recoverable when persisting its retry state fails", async () => {
    const { storage } = memoryStorage();
    let putCount = 0;
    storage.put = async () => {
      putCount += 1;
      if (putCount === 3) throw new Error("retry persistence failed");
    };
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: { push: async () => Promise.reject(new Error("offline")) },
    });
    await engine.enqueue(mutation());

    await expect(engine.drain()).rejects.toThrow("retry persistence failed");
    expect(engine.getSnapshot()[0]).toMatchObject({ status: "queued", nextAttemptAt: null });
    engine.dispose();
  });

  it("keeps a rejected command recoverable when persisting attention fails", async () => {
    const { storage } = memoryStorage();
    let putCount = 0;
    storage.put = async () => {
      putCount += 1;
      if (putCount === 3) throw new Error("attention persistence failed");
    };
    const engine = createOutboxEngine({
      classifyTransportError: () => ({
        code: "forbidden",
        currentVersion: null,
        kind: "permanent",
        message: "Membership changed.",
      }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: { push: async () => Promise.reject(new Error("forbidden")) },
    });
    await engine.enqueue(mutation());

    await expect(engine.drain()).rejects.toThrow("attention persistence failed");
    expect(engine.getSnapshot()[0]).toMatchObject({ status: "queued", attention: null });
    engine.dispose();
  });

  it("surfaces a permanent version conflict for user attention", async () => {
    const { storage } = memoryStorage();
    const engine = createOutboxEngine({
      classifyTransportError: () => ({
        kind: "permanent",
        code: "conflict",
        currentVersion: 4,
        message: "Version changed.",
      }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: {
        push: async () => Promise.reject(new Error("Version changed.")),
      },
    });

    await engine.enqueue(mutation());
    await engine.drain();

    expect(engine.getSnapshot()[0]).toMatchObject({
      attention: { code: "conflict", currentVersion: 4 },
      status: "needs-attention",
    });
    await expect(engine.retry(commandId)).rejects.toThrow("cannot succeed unchanged");
  });

  it("rejects unknown fields recovered from durable storage", async () => {
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage: {
        load: async () => [
          {
            attemptCount: 0,
            attention: null,
            enqueuedAt: "2026-08-02T10:00:00.000Z",
            mutation: mutation(),
            nextAttemptAt: null,
            schemaVersion: 1,
            status: "queued",
            editorContent: { type: "doc" },
          },
        ],
        put: async () => undefined,
        remove: async () => undefined,
      },
      transport: { push: async () => accepted() },
    });

    await expect(engine.initialize()).rejects.toThrow("unknown field");
    engine.dispose();
  });

  it("durably discards only a command that needs attention so FIFO can continue", async () => {
    const { storage, values } = memoryStorage();
    const secondId = "00000000-0000-4000-8000-000000000003" as CommandId;
    const engine = createOutboxEngine({
      classifyTransportError: () => ({
        kind: "permanent",
        code: "conflict",
        currentVersion: 4,
        message: "Version changed.",
      }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: { push: async () => Promise.reject(new Error("Version changed.")) },
    });
    await engine.enqueue(mutation(commandId));
    await engine.enqueue(mutation(secondId));

    await expect(engine.discard(secondId)).rejects.toThrow("needs attention");
    await engine.drain();
    expect(engine.getSnapshot()[0]?.status).toBe("needs-attention");
    await engine.discard(commandId);

    expect(values.has(commandId)).toBe(false);
    expect(engine.getSnapshot().map((item) => item.mutation.commandId)).toEqual([secondId]);
    engine.dispose();
  });

  it("caps transient exponential backoff at sixteen seconds", async () => {
    const { storage } = memoryStorage();
    let now = Date.parse("2026-08-02T10:00:00.000Z");
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => now },
      random: { next: () => 0.5 },
      storage,
      transport: { push: async () => Promise.reject(new Error("offline")) },
    });
    await engine.enqueue(mutation());

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Each retry becomes eligible only after the preceding clock advance.
      // eslint-disable-next-line no-await-in-loop
      await engine.drain();
      const queued = engine.getSnapshot()[0];
      expect(queued?.status).toBe("queued");
      const nextAttemptAt = queued?.nextAttemptAt;
      expect(nextAttemptAt).not.toBeNull();
      delays.push((nextAttemptAt ?? now) - now);
      now = nextAttemptAt ?? now;
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, maximumRetryDelayMs]);
    engine.dispose();
  });

  it("schedules a transient retry when its backoff becomes eligible", async () => {
    const { storage } = memoryStorage();
    let now = Date.parse("2026-08-02T10:00:00.000Z");
    const scheduled: {
      current: Readonly<{ delayMs: number; task: () => void }> | null;
    } = { current: null };
    let pushCount = 0;
    const acceptedCommands: CommandId[] = [];
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => now },
      onAccepted: (acceptedCommandId) => acceptedCommands.push(acceptedCommandId),
      random: { next: () => 0.5 },
      scheduler: {
        schedule: (delayMs, task) => {
          scheduled.current = { delayMs, task };
          return () => {
            scheduled.current = null;
          };
        },
      },
      storage,
      transport: {
        push: async () => {
          pushCount += 1;
          if (pushCount === 1) throw new Error("offline");
          return accepted();
        },
      },
    });
    await engine.enqueue(mutation());

    await engine.drain();
    expect(scheduled.current).toMatchObject({ delayMs: 1_000 });
    const wake = scheduled.current;
    if (wake === null) throw new Error("Expected a scheduled retry.");
    now += wake.delayMs;
    wake.task();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushCount).toBe(2);
    expect(acceptedCommands).toEqual([commandId]);
    expect(engine.getSnapshot()).toEqual([]);
    engine.dispose();
  });

  it("preserves FIFO within an organization scope", async () => {
    const { storage } = memoryStorage();
    let now = Date.parse("2026-08-02T10:00:00.000Z");
    const secondId = "00000000-0000-4000-8000-000000000003" as CommandId;
    const sent: CommandId[] = [];
    const engine = createOutboxEngine({
      classifyTransportError: () => ({
        kind: "permanent",
        code: "invalid",
        currentVersion: null,
        message: "Rejected.",
      }),
      clock: { now: () => now++ },
      random: { next: () => 0.5 },
      storage,
      transport: {
        push: async (request) => {
          const id = request.commands[0]!.commandId;
          sent.push(id);
          return accepted(id);
        },
      },
    });

    await engine.enqueue(mutation(commandId));
    await engine.enqueue(mutation(secondId));
    await engine.drain();

    expect(sent).toEqual([commandId, secondId]);
  });

  it("stops selecting new deliveries after disposal while one request is in flight", async () => {
    const { storage } = memoryStorage();
    const secondId = "00000000-0000-4000-8000-000000000003" as CommandId;
    const inFlight = { release: null as (() => void) | null };
    const sent: CommandId[] = [];
    const engine = createOutboxEngine({
      classifyTransportError: () => ({ kind: "transient" }),
      clock: { now: () => Date.parse("2026-08-02T10:00:00.000Z") },
      random: { next: () => 0.5 },
      storage,
      transport: {
        push: async (request) => {
          const id = request.commands[0]!.commandId;
          sent.push(id);
          if (id === commandId) {
            await new Promise<void>((resolve) => {
              inFlight.release = resolve;
            });
          }
          return accepted(id);
        },
      },
    });
    await engine.enqueue(mutation(commandId));
    await engine.enqueue(mutation(secondId));
    const draining = engine.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    engine.dispose();
    const finish = inFlight.release;
    if (finish === null) throw new Error("Expected an in-flight delivery.");
    finish();
    await draining;

    expect(sent).toEqual([commandId]);
    await expect(engine.drain()).rejects.toThrow("disposed");
  });
});
