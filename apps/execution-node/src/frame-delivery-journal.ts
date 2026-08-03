import { decodeConnectNodeFrame, type ConnectNodeFrame } from "@glass/contracts/connect";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

type PendingFrame = Readonly<{ frame: ConnectNodeFrame; sessionId: string }>;
export type FrameDeliveryFlushResult = Readonly<{ delivered: number; pending: number }>;

const decodePending = (input: unknown): PendingFrame | null => {
  if (typeof input !== "object" || input === null || !("sessionId" in input) || !("frame" in input))
    return null;
  if (
    typeof input.sessionId !== "string" ||
    input.sessionId.length < 1 ||
    input.sessionId.length > 128
  )
    return null;
  const frame = decodeConnectNodeFrame(input.frame);
  return frame.ok ? { sessionId: input.sessionId, frame: frame.value } : null;
};

const syncDirectory = async (path: string): Promise<void> => {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some platforms do not permit opening directories; file fsync still protects content.
  }
};

export class FrameDeliveryJournal {
  private readonly root: string;
  private readonly deliver: (sessionId: string, frame: ConnectNodeFrame) => Promise<void>;

  constructor(
    root: string,
    deliver: (sessionId: string, frame: ConnectNodeFrame) => Promise<void>,
  ) {
    this.root = root;
    this.deliver = deliver;
  }

  async record(sessionId: string, frame: ConnectNodeFrame): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(
        `${sessionId}\0${frame.requestId}\0${frame.operationId}\0${"sequence" in frame ? frame.sequence : "error"}`,
      )
      .digest("hex");
    const target = join(this.root, `${key}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ sessionId, frame }));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    await syncDirectory(this.root);
    await this.deliver(sessionId, frame);
    await rm(target, { force: true });
    await syncDirectory(this.root);
  }

  async flush(): Promise<FrameDeliveryFlushResult> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const filenames = (await readdir(this.root)).filter((value) => value.endsWith(".json"));
    const selected = filenames.slice(0, 2_048);
    let delivered = 0;
    let pending = filenames.length - selected.length;
    for (const filename of selected) {
      const path = join(this.root, filename);
      try {
        // eslint-disable-next-line no-await-in-loop -- Replay is deliberately ordered and bounded to avoid an ingestion burst.
        const decodedFrame = decodePending(JSON.parse(await readFile(path, "utf8")) as unknown);
        if (decodedFrame === null) continue;
        // eslint-disable-next-line no-await-in-loop -- Preserve durable frame order across restart.
        await this.deliver(decodedFrame.sessionId, decodedFrame.frame);
        // eslint-disable-next-line no-await-in-loop -- Acknowledgement removal follows its matching delivery.
        await rm(path, { force: true });
        // eslint-disable-next-line no-await-in-loop -- Persist each acknowledgement before replaying the next frame.
        await syncDirectory(this.root);
        delivered += 1;
      } catch {
        // Retain valid undelivered frames for the next authenticated retry.
        pending += 1;
      }
    }
    return { delivered, pending };
  }
}

export class FrameDeliveryRecovery {
  private attempt = 0;
  private inFlight: Promise<FrameDeliveryFlushResult> | null = null;
  private retryAt = 0;
  private readonly journal: FrameDeliveryJournal;
  private readonly now: () => number;

  constructor(journal: FrameDeliveryJournal, now: () => number = Date.now) {
    this.journal = journal;
    this.now = now;
  }

  flush(force = false): Promise<FrameDeliveryFlushResult> {
    if (this.inFlight !== null) return this.inFlight;
    if (!force && this.now() < this.retryAt) return Promise.resolve({ delivered: 0, pending: 1 });
    this.inFlight = this.journal
      .flush()
      .then((result) => {
        if (result.pending === 0) {
          this.attempt = 0;
          this.retryAt = 0;
        } else {
          this.attempt = Math.min(this.attempt + 1, 8);
          this.retryAt = this.now() + Math.min(30_000, 500 * 2 ** this.attempt);
        }
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
