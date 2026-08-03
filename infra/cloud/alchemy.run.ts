import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { retain } from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  glassCloudMigrationsDirectory,
  glassCloudProductionStage,
  resolveGlassCloudStage,
} from "./src/environments.ts";

const rateLimitNamespaceId = (stage: string, bucket: "mutation" | "node" | "poll"): number => {
  let hash = 2_166_136_261;
  for (const character of `glass-cloud:${stage}:environment-trust:${bucket}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return hash >>> 0 || 1;
};

const cloudFoundation = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const policy = resolveGlassCloudStage(stage);
  const githubClientId = yield* Config.redacted("GITHUB_CLIENT_ID");
  const githubClientSecret = yield* Config.redacted("GITHUB_CLIENT_SECRET");
  const betterAuthSecret = yield* Config.redacted("BETTER_AUTH_SECRET");
  const connectTicketSecret = yield* Config.redacted("CONNECT_TICKET_SECRET");
  const connectTunnelZoneName = yield* Config.string("CONNECT_TUNNEL_ZONE_NAME");

  const database =
    policy.database.ownership === "owner"
      ? yield* Planetscale.PostgresDatabase("Database", {
          clusterSize: policy.database.clusterSize,
          migrationsDir: glassCloudMigrationsDirectory,
          region: { slug: "eu-central" },
          replicas: policy.database.replicas,
        }).pipe(retain())
      : yield* Planetscale.PostgresDatabase.ref("Database", {
          stage: glassCloudProductionStage,
        });

  const branch = yield* Effect.gen(function* () {
    if (policy.database.ownership === "owner") {
      return "main" as const;
    }

    const branchResource = Planetscale.PostgresBranch("Branch", {
      database,
      clusterSize: policy.database.clusterSize,
      migrationsDir: glassCloudMigrationsDirectory,
      replicas: policy.database.replicas,
    });

    return policy.database.retainBranch
      ? yield* branchResource.pipe(retain())
      : yield* branchResource;
  });

  const runtimeRole = yield* Planetscale.PostgresRole("RuntimeRole", {
    database,
    branch,
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("Hyperdrive", {
    caching: { disabled: true },
    dev: runtimeRole.pooledOrigin,
    origin: runtimeRole.origin,
    originConnectionLimit: 20,
  });

  const tunnelZone = Cloudflare.Zone.Zone("ConnectTunnelZone", {
    name: connectTunnelZoneName,
  });

  type TunnelControlShape = {
    provision: (input: {
      hostname: string;
      name: string;
      ownershipId: string;
      service: string;
    }) => Effect.Effect<{ dnsRecordId: string; tunnelId: string }, unknown, Alchemy.RuntimeContext>;
    disconnect: (tunnelId: string) => Effect.Effect<void, unknown, Alchemy.RuntimeContext>;
    delete: (input: {
      dnsRecordId: string;
      ownershipId: string;
      tunnelId: string;
    }) => Effect.Effect<void, unknown, Alchemy.RuntimeContext>;
    token: (tunnelId: string) => Effect.Effect<string, unknown, Alchemy.RuntimeContext>;
  };

  class TunnelControlWorker extends Cloudflare.Worker<TunnelControlWorker, TunnelControlShape>()(
    "TunnelControl",
  ) {}

  const tunnelControlLayer = TunnelControlWorker.make(
    {
      compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] },
      workersDev: false,
    },
    Effect.gen(function* () {
      const tunnels = yield* Cloudflare.Tunnel.ReadWriteTunnel();
      const dns = yield* Cloudflare.DNS.ReadWriteDns(tunnelZone);
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const cleanupToken = yield* Cloudflare.ApiToken.AccountApiToken(
        "TunnelConnectionCleanupToken",
        {
          accountId,
          policies: [
            {
              effect: "allow",
              permissionGroups: ["Cloudflare Tunnel Write"],
              resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
          ],
        },
      );
      const cleanupTokenValue = yield* cleanupToken.value;
      const cleanupAccountId = yield* cleanupToken.accountId;
      return {
        provision: (input) =>
          Effect.gen(function* () {
            const listed = yield* tunnels.list({ isDeleted: false, name: input.name });
            const existing = listed.result?.find((candidate) => candidate.name === input.name);
            if (
              existing !== undefined &&
              (existing.configSrc !== "cloudflare" || existing.accountTag !== accountId)
            )
              return yield* Effect.die("Tunnel ownership verification failed.");
            const tunnel =
              existing?.id === undefined
                ? yield* tunnels.create({ name: input.name, configSrc: "cloudflare" })
                : existing;
            if (tunnel.id === undefined || tunnel.id === null)
              return yield* Effect.die("Tunnel creation returned no id.");
            const tunnelId = tunnel.id;
            yield* tunnels.putConfiguration(tunnelId, {
              ingress: [
                { hostname: input.hostname, service: input.service },
                { service: "http_status:404" },
              ],
            });
            const records = yield* dns.listDnsRecords({
              name: { exact: input.hostname },
              type: "CNAME",
            });
            const existingRecord = records.result?.find((record) => record.name === input.hostname);
            const ownershipComment = `glass-connect-owner:${input.ownershipId}`;
            if (existingRecord !== undefined && existingRecord.comment !== ownershipComment)
              return yield* Effect.die("DNS ownership verification failed.");
            const target = `${tunnelId}.cfargotunnel.com`;
            const record =
              existingRecord?.id === undefined
                ? yield* dns.createDnsRecord({
                    content: target,
                    comment: ownershipComment,
                    name: input.hostname,
                    proxied: true,
                    ttl: 1,
                    type: "CNAME",
                  })
                : yield* dns.updateDnsRecord(existingRecord.id, {
                    content: target,
                    comment: ownershipComment,
                    name: input.hostname,
                    proxied: true,
                    ttl: 1,
                    type: "CNAME",
                  });
            return { tunnelId, dnsRecordId: record.id };
          }),
        disconnect: (tunnelId) =>
          Effect.gen(function* () {
            const token = Redacted.value(yield* cleanupTokenValue);
            const boundAccountId = yield* cleanupAccountId;
            const response = yield* Effect.tryPromise(() =>
              fetch(
                `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(boundAccountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`,
                {
                  method: "DELETE",
                  headers: { authorization: `Bearer ${token}` },
                },
              ),
            );
            if (response.status === 404) return;
            const envelope = yield* Effect.tryPromise(() => response.json() as Promise<unknown>);
            if (
              !response.ok ||
              typeof envelope !== "object" ||
              envelope === null ||
              !("success" in envelope) ||
              envelope.success !== true
            )
              return yield* Effect.die("Cloudflare rejected tunnel connection cleanup.");
          }),
        delete: ({ dnsRecordId, ownershipId, tunnelId }) =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const record = yield* dns.getDnsRecord(dnsRecordId);
              if (record.comment !== `glass-connect-owner:${ownershipId}`)
                return yield* Effect.die("DNS ownership verification failed.");
              yield* dns.deleteDnsRecord(dnsRecordId);
            }).pipe(
              Effect.catch((error) =>
                Reflect.get(error, "_tag") === "CloudflareHttpError" &&
                "status" in error &&
                error.status === 404
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );
            yield* Effect.gen(function* () {
              const tunnel = yield* tunnels.get(tunnelId);
              if (
                tunnel.name !== `glass-${policy.stage}-${ownershipId}` ||
                tunnel.configSrc !== "cloudflare" ||
                tunnel.accountTag !== accountId
              )
                return yield* Effect.die("Tunnel ownership verification failed.");
              yield* tunnels.delete(tunnelId);
            }).pipe(Effect.catchTag("TunnelNotFound", () => Effect.void));
          }),
        token: (tunnelId) => tunnels.getToken(tunnelId),
      } satisfies TunnelControlShape;
    }).pipe(
      Effect.provide(
        Layer.merge(Cloudflare.Tunnel.ReadWriteTunnelBinding, Cloudflare.DNS.ReadWriteDnsHttp),
      ),
    ),
  );

  const tunnelControl = yield* TunnelControlWorker.pipe(Effect.provide(tunnelControlLayer));

  const worker = yield* Cloudflare.Worker("Api", {
    crons: ["*/1 * * * *"],
    assets: {
      directory: "../../apps/web/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/health", "/v1/*"],
    },
    compatibility: {
      date: "2026-08-01",
      flags: ["nodejs_compat"],
    },
    env: {
      BETTER_AUTH_SECRET: betterAuthSecret,
      CONNECT_AUTHORITY: Cloudflare.DurableObject("ConnectAuthority", {
        className: "GlassConnectAuthority",
      }),
      CONNECT_TICKET_SECRET: connectTicketSecret,
      CONNECT_NODE_RATE_LIMIT: Cloudflare.RateLimit("ConnectNodeRateLimit", {
        namespaceId: rateLimitNamespaceId(policy.stage, "node"),
        simple: { limit: 10_000, period: 60 },
      }),
      CONNECT_TUNNEL_ZONE_NAME: connectTunnelZoneName,
      GITHUB_CLIENT_ID: githubClientId,
      GITHUB_CLIENT_SECRET: githubClientSecret,
      HYPERDRIVE: hyperdrive,
      TUNNEL_CONTROL: tunnelControl,
      TRUST_MUTATION_RATE_LIMIT: Cloudflare.RateLimit("TrustMutationRateLimit", {
        namespaceId: rateLimitNamespaceId(policy.stage, "mutation"),
        simple: { limit: 20, period: 60 },
      }),
      TRUST_POLL_RATE_LIMIT: Cloudflare.RateLimit("TrustPollRateLimit", {
        namespaceId: rateLimitNamespaceId(policy.stage, "poll"),
        simple: { limit: 120, period: 60 },
      }),
    },
    main: "../../apps/api/src/index.ts",
  });

  return {
    branch: typeof branch === "string" ? branch : branch.name,
    database: database.name,
    stage: policy.stage,
    worker: worker.workerName,
    workerUrl: worker.url,
    webUrl: worker.url,
  };
});

export default Alchemy.Stack(
  "GlassCloud",
  {
    providers: Cloudflare.providers().pipe(Layer.merge(Planetscale.providers())),
    state: Cloudflare.state(),
  },
  cloudFoundation,
);
