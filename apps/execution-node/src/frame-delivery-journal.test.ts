import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { FrameDeliveryJournal, FrameDeliveryRecovery } from "./frame-delivery-journal.ts";

const frame = {
  type: "operation.event",
  requestId: "request-1",
  operationId: "operation-1",
  event: "result",
  sequence: 0,
  payload: { ok: true },
} as const;

describe("frame delivery journal", () => {
  it("retains failed delivery and replays it after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-frame-journal-"));
    const failing = new FrameDeliveryJournal(root, async () => {
      throw new Error("offline");
    });
    await expect(failing.record("session-1", frame)).rejects.toThrow("offline");
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const delivered: unknown[] = [];
    const recovered = new FrameDeliveryJournal(root, async (sessionId, value) => {
      delivered.push({ sessionId, value });
    });
    await recovered.flush();
    expect(delivered).toEqual([{ sessionId: "session-1", value: frame }]);
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("single-flight retries a retained frame exactly once after Cloud recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-frame-recovery-"));
    let cloudAvailable = false;
    let successfulAcknowledgements = 0;
    const journal = new FrameDeliveryJournal(root, async () => {
      if (!cloudAvailable) throw new Error("Cloud unavailable");
      successfulAcknowledgements += 1;
    });
    await expect(journal.record("session-1", frame)).rejects.toThrow("Cloud unavailable");
    const recovery = new FrameDeliveryRecovery(journal, () => 0);
    await expect(recovery.flush(true)).resolves.toEqual({ delivered: 0, pending: 1 });
    cloudAvailable = true;
    const [first, second] = await Promise.all([recovery.flush(true), recovery.flush(true)]);
    expect(first).toEqual({ delivered: 1, pending: 0 });
    expect(second).toEqual(first);
    expect(successfulAcknowledgements).toBe(1);
    await recovery.flush(true);
    expect(successfulAcknowledgements).toBe(1);
  });
});
