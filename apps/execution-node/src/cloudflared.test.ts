import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

import {
  CloudflaredSupervisor,
  installVerifiedCloudflared,
  maxConnectorDownloadBytes,
  safeArchiveEntry,
} from "./cloudflared.ts";

describe("connector binary verification", () => {
  it("rejects checksum mismatch without installing executable bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-connector-"));
    const asset = {
      platform: "linux",
      arch: "x64",
      archive: "binary",
      version: "2026.7.3",
      downloadUrl:
        "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64",
      sha256: "0".repeat(64),
      installedSha256: "0".repeat(64),
    } as const;
    await expect(
      installVerifiedCloudflared(
        asset,
        root,
        async () => new Response("not trusted", { status: 200 }),
      ),
    ).rejects.toThrow("checksum");
    await expect(readFile(join(root, "cloudflared-2026.7.3-linux-x64"))).rejects.toThrow();
  });

  it("rejects archive traversal entries", () => {
    expect(safeArchiveEntry("cloudflared")).toBe(true);
    expect(safeArchiveEntry("../cloudflared")).toBe(false);
    expect(safeArchiveEntry("/tmp/cloudflared")).toBe(false);
  });

  it("rejects an oversized connector before buffering its body", async () => {
    const root = await mkdtemp(join(tmpdir(), "glass-connector-size-"));
    const asset = {
      platform: "linux",
      arch: "x64",
      archive: "binary",
      version: "2026.7.3",
      downloadUrl:
        "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64",
      sha256: "0".repeat(64),
      installedSha256: "0".repeat(64),
    } as const;
    await expect(
      installVerifiedCloudflared(
        asset,
        root,
        async () =>
          new Response("small", {
            status: 200,
            headers: { "content-length": String(maxConnectorDownloadBytes + 1) },
          }),
      ),
    ).rejects.toThrow("byte bound");
  });

  it("redacts the memory-only token and schedules restart after a real process crash", async () => {
    const token = "secret-connector-token-that-must-not-leak";
    const logs: string[] = [];
    let restart: (() => void) | undefined;
    const delays: number[] = [];
    const supervisor = new CloudflaredSupervisor({
      getConfiguration: async () => ({ tunnelId: "tunnel", hostname: "node.glass.test", token }),
      installBinary: async () => process.execPath,
      installRoot: "/unused",
      log: (entry) => logs.push(entry.value),
      readinessProbe: async () => undefined,
      schedule: (callback, delay) => {
        restart = callback;
        delays.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      spawnProcess: ((_binary: string, _args: readonly string[], options: unknown) =>
        spawn(
          process.execPath,
          ["-e", "process.stderr.write(process.env.TUNNEL_TOKEN); process.exit(7)"],
          options as never,
        )) as unknown as typeof spawn,
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).toContain("[REDACTED]");
    expect(restart).toBeTypeOf("function");
    restart?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(delays).toEqual([1_000, 2_000]);
    await supervisor.stop();
  });

  it("does not report healthy until the connector readiness probe succeeds", async () => {
    let releaseReadiness: (() => void) | undefined;
    let healthy = 0;
    let disconnected = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const supervisor = new CloudflaredSupervisor({
      getConfiguration: async () => ({
        tunnelId: "tunnel",
        hostname: "node.glass.test",
        token: "t".repeat(32),
      }),
      installBinary: async () => process.execPath,
      installRoot: "/unused",
      onDisconnected: () => {
        disconnected += 1;
      },
      onHealthy: () => {
        healthy += 1;
      },
      readinessProbe: () =>
        new Promise<void>((resolve) => {
          releaseReadiness = resolve;
        }),
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      spawnProcess: ((_binary: string, _args: readonly string[], options: unknown) => {
        child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], options as never);
        return child;
      }) as unknown as typeof spawn,
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(healthy).toBe(0);
    releaseReadiness?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(healthy).toBe(1);
    child?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(disconnected).toBe(1);
    await supervisor.stop();
  });

  it("terminates an unready connector before scheduling its retry", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    let scheduledAfterExit = false;
    const supervisor = new CloudflaredSupervisor({
      getConfiguration: async () => ({
        tunnelId: "tunnel",
        hostname: "node.glass.test",
        token: "t".repeat(32),
      }),
      installBinary: async () => process.execPath,
      installRoot: "/unused",
      readinessProbe: async () => {
        throw new Error("readiness failed");
      },
      schedule: () => {
        scheduledAfterExit = child?.exitCode !== null || child?.signalCode !== null;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      spawnProcess: ((_binary: string, _args: readonly string[], options: unknown) => {
        child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], options as never);
        return child;
      }) as unknown as typeof spawn,
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(scheduledAfterExit).toBe(true);
    await supervisor.stop();
  });

  it("does not schedule a retry when a fatal handler stops the supervisor", async () => {
    let scheduled = false;
    let supervisor!: CloudflaredSupervisor;
    supervisor = new CloudflaredSupervisor({
      getConfiguration: async () => {
        throw new Error("terminal identity failure");
      },
      installRoot: "/unused",
      onFatal: () => {
        void supervisor.stop();
      },
      schedule: () => {
        scheduled = true;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    });
    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduled).toBe(false);
  });
});
