import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import { retain } from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  glassCloudMigrationsDirectory,
  glassCloudProductionStage,
  resolveGlassCloudStage,
} from "./src/environments.ts";

const cloudFoundation = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const policy = resolveGlassCloudStage(stage);
  const githubClientId = yield* Config.redacted("GITHUB_CLIENT_ID");
  const githubClientSecret = yield* Config.redacted("GITHUB_CLIENT_SECRET");
  const betterAuthSecret = yield* Config.redacted("BETTER_AUTH_SECRET");

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

  const worker = yield* Cloudflare.Worker("Api", {
    compatibility: {
      date: "2026-08-01",
      flags: ["nodejs_compat"],
    },
    env: {
      BETTER_AUTH_SECRET: betterAuthSecret,
      GITHUB_CLIENT_ID: githubClientId,
      GITHUB_CLIENT_SECRET: githubClientSecret,
      HYPERDRIVE: hyperdrive,
    },
    main: "../../apps/api/src/index.ts",
  });

  return {
    branch: typeof branch === "string" ? branch : branch.name,
    database: database.name,
    stage: policy.stage,
    worker: worker.workerName,
    workerUrl: worker.url,
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
