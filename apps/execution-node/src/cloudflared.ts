import {
  cloudflaredReleaseManifest,
  type CloudflaredReleaseAsset,
  type ManagedTunnelConfiguration,
} from "@glass/contracts/connect-tunnel";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { extract } from "tar";

export const maxConnectorDownloadBytes = 128 * 1_048_576;

export const connectorPlatform = (): CloudflaredReleaseAsset["platform"] => {
  const value = hostPlatform();
  if (value !== "darwin" && value !== "linux" && value !== "win32")
    throw new Error(`Unsupported connector platform: ${value}.`);
  return value;
};

export const connectorArch = (): CloudflaredReleaseAsset["arch"] => {
  const value = hostArch();
  if (value !== "arm64" && value !== "x64")
    throw new Error(`Unsupported connector architecture: ${value}.`);
  return value;
};

export const safeArchiveEntry = (entry: string): boolean => {
  const normalized = normalize(entry);
  return (
    entry !== "" &&
    !isAbsolute(entry) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`) &&
    !normalized.split(sep).includes("..")
  );
};

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export const installVerifiedCloudflared = async (
  asset: CloudflaredReleaseAsset,
  installRoot: string,
  fetchAsset: typeof fetch = fetch,
): Promise<string> => {
  const filename = `cloudflared-${asset.version}-${asset.platform}-${asset.arch}${asset.platform === "win32" ? ".exe" : ""}`;
  const target = join(installRoot, filename);
  try {
    if (digest(await readFile(target)) === asset.installedSha256) return target;
  } catch {
    // A missing or invalid cached binary is replaced only after verification.
  }
  const response = await fetchAsset(asset.downloadUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Connector download returned ${response.status}.`);
  const finalUrl = new URL(response.url || asset.downloadUrl);
  if (
    finalUrl.protocol !== "https:" ||
    !["github.com", "release-assets.githubusercontent.com"].includes(finalUrl.hostname)
  )
    throw new Error("Connector download redirected to an untrusted host.");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxConnectorDownloadBytes)
    throw new Error("Connector download exceeds the byte bound.");
  if (response.body === null) throw new Error("Connector download returned no body.");
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- The stream is consumed sequentially to enforce the running byte bound.
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > maxConnectorDownloadBytes) {
      // eslint-disable-next-line no-await-in-loop -- Cancellation prevents additional untrusted bytes from buffering.
      await reader.cancel();
      throw new Error("Connector download exceeds the byte bound.");
    }
    chunks.push(chunk.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (digest(bytes) !== asset.sha256) throw new Error("Connector checksum verification failed.");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  if (asset.archive === "tar.gz") {
    const archive = `${temporary}.tgz`;
    const extraction = `${temporary}.dir`;
    await writeFile(archive, bytes, { mode: 0o600 });
    await mkdir(extraction, { mode: 0o700 });
    try {
      await extract({
        cwd: extraction,
        file: archive,
        filter: (path) => {
          if (!safeArchiveEntry(path))
            throw new Error("Connector archive contains an unsafe path.");
          return path === "cloudflared" || path === "./cloudflared";
        },
        gzip: true,
        preservePaths: false,
        strict: true,
      });
      const extracted = join(extraction, "cloudflared");
      if (digest(await readFile(extracted)) !== asset.installedSha256)
        throw new Error("Extracted connector checksum verification failed.");
      await rename(extracted, temporary);
    } finally {
      await rm(archive, { force: true });
      await rm(extraction, { force: true, recursive: true });
    }
  } else {
    await writeFile(temporary, bytes, { mode: 0o700 });
  }
  await chmod(temporary, 0o700);
  await rm(target, { force: true });
  await rename(temporary, target);
  return target;
};

export type ConnectorLog = Readonly<{ stream: "stderr" | "stdout"; value: string }>;

export type CloudflaredSupervisorOptions = Readonly<{
  getConfiguration: () => Promise<ManagedTunnelConfiguration>;
  installBinary?: (asset: CloudflaredReleaseAsset, root: string) => Promise<string>;
  installRoot: string;
  log?: (entry: ConnectorLog) => void;
  now?: () => number;
  onDisconnected?: (error: unknown) => void;
  onFatal?: (error: unknown) => void;
  onHealthy?: () => void;
  readinessProbe?: (origin: string, child: ChildProcess) => Promise<void>;
  spawnProcess?: typeof spawn;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  stableHealthyMilliseconds?: number;
}>;

const reserveMetricsOrigin = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Metrics port did not bind.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
};

const waitUntilConnectorReady = async (origin: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Connector exited before becoming healthy.");
    try {
      // eslint-disable-next-line no-await-in-loop -- Readiness must be sampled sequentially until the bounded deadline.
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Readiness is retried until the bounded deadline or process exit.
    }
    // eslint-disable-next-line no-await-in-loop -- Poll spacing prevents a loopback readiness hot loop.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Connector readiness timed out.");
};

export const hostCloudflaredRelease = (): CloudflaredReleaseAsset => {
  const asset = cloudflaredReleaseManifest.find(
    (candidate) => candidate.platform === connectorPlatform() && candidate.arch === connectorArch(),
  );
  if (asset === undefined) throw new Error("No pinned connector binary supports this host.");
  return asset;
};

const redacted = (value: string, secrets: readonly string[]): string =>
  secrets
    .reduce(
      (output, secret) => (secret === "" ? output : output.split(secret).join("[REDACTED]")),
      value,
    )
    .slice(0, 4_096);

export class CloudflaredSupervisor {
  private child: ChildProcess | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private healthySince: number | null = null;
  private token: string | null = null;

  private readonly options: CloudflaredSupervisorOptions;

  constructor(options: CloudflaredSupervisorOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.launch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.token = null;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    try {
      const configuration = await this.options.getConfiguration();
      if (this.stopped) return;
      const binary = await (this.options.installBinary ?? installVerifiedCloudflared)(
        hostCloudflaredRelease(),
        this.options.installRoot,
      );
      if (this.stopped) return;
      this.token = configuration.token;
      const metricsOrigin = await reserveMetricsOrigin();
      const child = (this.options.spawnProcess ?? spawn)(
        binary,
        ["tunnel", "--no-autoupdate", "--metrics", metricsOrigin.slice("http://".length), "run"],
        {
          env: { ...process.env, TUNNEL_TOKEN: configuration.token },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.child = child;
      let handledExit = false;
      let emittedLogLines = 0;
      const secrets = [configuration.token] as const;
      const capture = (stream: ConnectorLog["stream"], chunk: Buffer): void => {
        for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
          if (line === "" || emittedLogLines >= 500) continue;
          emittedLogLines += 1;
          this.options.log?.({ stream, value: redacted(line, secrets) });
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      const crashOnce = (error: unknown): void => {
        if (handledExit) return;
        handledExit = true;
        this.crashed(error);
      };
      child.once("error", crashOnce);
      child.once("exit", (code) =>
        crashOnce(new Error(`Connector exited with code ${code ?? "unknown"}.`)),
      );
      try {
        await (this.options.readinessProbe ?? waitUntilConnectorReady)(metricsOrigin, child);
      } catch (error) {
        handledExit = true;
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
          ]);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        this.crashed(error);
        return;
      }
      if (this.stopped || handledExit || child !== this.child) return;
      this.healthySince = (this.options.now ?? Date.now)();
      this.options.onHealthy?.();
    } catch (error) {
      this.crashed(error);
    }
  }

  private crashed(error: unknown): void {
    if (this.stopped || this.retry !== null) return;
    this.child = null;
    this.token = null;
    const now = (this.options.now ?? Date.now)();
    if (
      this.healthySince !== null &&
      now - this.healthySince >= (this.options.stableHealthyMilliseconds ?? 30_000)
    )
      this.attempt = 0;
    this.healthySince = null;
    this.attempt = Math.min(this.attempt + 1, 8);
    const delay = Math.min(30_000, 500 * 2 ** this.attempt);
    this.options.onFatal?.(error);
    this.options.onDisconnected?.(error);
    this.retry = (this.options.schedule ?? setTimeout)(() => {
      this.retry = null;
      void this.launch();
    }, delay);
  }
}
