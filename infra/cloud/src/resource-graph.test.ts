import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const stackSource = readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
const tunnelControlSource = readFileSync(
  new URL("./tunnel-control-worker.ts", import.meta.url),
  "utf8",
);

describe("Glass Cloud Alchemy resource graph", () => {
  it("lets Alchemy generate provider resource names", () => {
    expect(stackSource).not.toMatch(/Postgres(?:Database|Branch|Role)\([^)]*\{[^}]*\bname:/su);
    expect(stackSource).toContain('PostgresDatabase("Database"');
    expect(stackSource).toContain('PostgresBranch("Branch"');
    expect(stackSource).toContain('PostgresRole("RuntimeRole"');
    expect(stackSource).toContain('Hyperdrive.Connection("Hyperdrive"');
    expect(stackSource).toContain('Cloudflare.Worker("Api"');
  });

  it("makes prod the database owner and references it from other stages", () => {
    expect(stackSource).toContain('PostgresDatabase.ref("Database"');
    expect(stackSource).toContain("stage: glassCloudProductionStage");
    expect(stackSource).toMatch(/PostgresDatabase[\s\S]*?\.pipe\(retain\(\)\)/u);
  });

  it("makes prod the Connect DNS zone owner and references it from other stages", () => {
    expect(stackSource).toContain('Cloudflare.Zone.Zone("ConnectTunnelZone"');
    expect(stackSource).toContain('Cloudflare.Zone.Zone.ref("ConnectTunnelZone"');
    expect(stackSource).toMatch(/ConnectTunnelZone[\s\S]*?\.pipe\(adopt\(true\), retain\(\)\)/u);
  });

  it("applies one committed migration chain to every database branch", () => {
    expect(stackSource.match(/migrationsDir: glassCloudMigrationsDirectory/gu)).toHaveLength(2);
    expect(stackSource).not.toContain("alchemy/Drizzle");
  });

  it("uses product-standard binding and secret names", () => {
    expect(stackSource).toContain('Config.redacted("GITHUB_CLIENT_ID")');
    expect(stackSource).toContain('Config.redacted("GITHUB_CLIENT_SECRET")');
    expect(stackSource).toContain('Config.redacted("BETTER_AUTH_SECRET")');
    expect(stackSource).not.toContain("Alchemy.makeRandom");
    expect(stackSource).toContain("BETTER_AUTH_SECRET: betterAuthSecret");
    expect(stackSource).toContain("HYPERDRIVE: hyperdrive");
    expect(stackSource).toContain('Cloudflare.RateLimit("TrustMutationRateLimit"');
    expect(stackSource).toContain('rateLimitNamespaceId(policy.stage, "mutation")');
    expect(stackSource).toContain("simple: { limit: 20, period: 60 }");
    expect(stackSource).toContain('Cloudflare.RateLimit("TrustPollRateLimit"');
    expect(stackSource).toContain('rateLimitNamespaceId(policy.stage, "poll")');
    expect(stackSource).toContain("simple: { limit: 120, period: 60 }");
    expect(stackSource).toContain("originConnectionLimit: 20");
    expect(stackSource).toContain('flags: ["nodejs_compat"]');
    expect(tunnelControlSource).toContain('flags: ["nodejs_compat"]');
    expect(tunnelControlSource).toContain("main: import.meta.url");
    expect(tunnelControlSource).not.toContain("ReadWriteTunnelBinding");
    expect(tunnelControlSource).not.toContain("ReadWriteDns");
    expect(tunnelControlSource).toContain('permissionGroups: ["Cloudflare Tunnel Write"]');
    expect(tunnelControlSource).toContain('permissionGroups: ["DNS Read", "DNS Write"]');
    expect(tunnelControlSource).toContain(
      "AbortSignal.timeout(providerRequestTimeoutMilliseconds)",
    );
    expect(tunnelControlSource).toContain("name.exact=");
    expect(tunnelControlSource).toContain("allowNotFound: true");
    expect(tunnelControlSource).toContain("providerAccountMatches");
    expect(tunnelControlSource).not.toContain("alchemy/Planetscale");
    expect(stackSource).not.toContain("GLASS_STAGE");
    expect(stackSource).not.toContain("BETTER_AUTH_URL");
  });
});
