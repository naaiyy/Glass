import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { retain } from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { adopt } from "alchemy/AdoptPolicy";
import {
  glassCloudMigrationsDirectory,
  glassCloudProductionStage,
  resolveGlassCloudStage,
} from "./src/environments.ts";
import tunnelControlLayer, { TunnelControlWorker } from "./src/tunnel-control-worker.ts";

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

  if (policy.database.ownership === "owner") {
    yield* Cloudflare.Zone.Zone("ConnectTunnelZone", {
      name: connectTunnelZoneName,
    }).pipe(adopt(true), retain());
  } else {
    yield* Cloudflare.Zone.Zone.ref("ConnectTunnelZone", {
      stage: glassCloudProductionStage,
    });
  }

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
