# Cloud infrastructure

This page is for Glass infrastructure and service operators.

## Current status

`infra/cloud` is the typed Milestone 2 resource graph. Alchemy's default
Cloudflare state store is deployed and encrypted. Production, staging, and
development are deployed and reconcile through the same graph. Each stage has
a successful apply, an idempotent second plan, and live service verification.
Local build, test, and typecheck do not change provider state.

| Environment | Worker                                                         |
| ----------- | -------------------------------------------------------------- |
| production  | `glasscloud-api-prod-lcuxsmngpdigrgum.naaiyyyy.workers.dev`    |
| staging     | `glasscloud-api-staging-rmhiqpuua7m4g6a3.naaiyyyy.workers.dev` |
| development | `glasscloud-api-dev-iqwgnfdineqiceki.naaiyyyy.workers.dev`     |

## Ownership and stages

The `GlassCloud` stack uses Alchemy's stage conventions:

| Stage       | Purpose               | PlanetScale ownership                            | Lifecycle  |
| ----------- | --------------------- | ------------------------------------------------ | ---------- |
| `prod`      | production            | owns the database and default `main` branch      | retained   |
| `staging`   | shared pre-production | references the `prod` database and owns a branch | retained   |
| `dev`       | shared development    | references the `prod` database and owns a branch | retained   |
| `dev_$USER` | personal development  | references the `prod` database and owns a branch | disposable |

Alchemy generates physical names from the stack, stage, logical resource ID,
and instance identity. Operators should use the generated provider names shown
by the plan rather than maintaining a second naming scheme in documentation or
deployment variables.

The production database is PlanetScale Postgres in `eu-central`, using
`PS_5_AWS_X86` with two replicas. Non-production branches use `PS_DEV` with no
replicas. All stages consume one committed migration chain generated from the
Better Auth CLI schema at `apps/api/src/db/schema.ts`.

Each stage owns a data-only runtime role and a Cloudflare Hyperdrive connection.
Hyperdrive query caching is disabled and its PlanetScale origin pool is capped
at 20 connections per environment.
The Worker receives `HYPERDRIVE`, Alchemy's deployment-stage metadata,
`BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Better
Auth uses the stage to allow only the matching generated `workers.dev` host
when resolving its OAuth base URL. Alchemy resolves each secret through `Config.redacted`
and uploads it as a Cloudflare `secret_text` binding. Authentication routes
remain unavailable when any required binding or durable database connection is
absent.

## Reconciliation contract

- Bootstrap `prod` before creating a branch stage because cross-stage
  references must resolve an existing production database.
- Generate and review Better Auth schema and Drizzle migrations before apply.
- Review an explicit plan for `prod`, `staging`, and shared `dev`; personal
  development may use Alchemy's default stage.
- Do not make adoption a source default. A provider conflict requires a fresh
  inventory and an explicit cleanup or adoption decision.
- Keep provider credentials, role passwords, OAuth secrets, signing material,
  and connection strings out of source, logs, URLs, outputs, fixtures, and
  client bundles.
- Verify Worker-to-Hyperdrive-to-PlanetScale connectivity and the complete
  GitHub authentication lifecycle after every environment deployment.
- Treat recovery, backup/restore, HA capacity, auditability, and secret rotation
  as release gates rather than local-test claims.

## Commands

```text
vp run --filter @glass/api auth:schema
vp run --filter @glass/api db:migrations
vp run --filter @glass/cloud-infrastructure plan:prod
vp run --filter @glass/cloud-infrastructure plan:staging
vp run --filter @glass/cloud-infrastructure plan:dev
vp run --filter @glass/cloud-infrastructure plan
```

After an apply, repeat the same plan and require no unexpected changes. Then
inspect the migration table, runtime role grants, Hyperdrive configuration,
Worker bindings, health endpoint, sign-in callback, session persistence, and
sign-out behavior.

The manually dispatched `Glass Cloud` GitHub Actions workflow uses the
`development`, `staging`, and `production` GitHub environments. Each environment
holds its own Better Auth signing secret, provider credentials, and OAuth
credentials. GitHub Actions reserves the `GITHUB_` prefix, so environment
storage uses `OAUTH_GITHUB_CLIENT_ID` and `OAUTH_GITHUB_CLIENT_SECRET`; the
workflow maps them to Better Auth's standard runtime names. Production
protection rules remain a GitHub authorization boundary rather than application
code.

CI uses a one-year Cloudflare account-owned token limited to Hyperdrive Write
and Workers Scripts Write, plus a PlanetScale service token limited to database,
branch, and connection management for the retained production database. Rotate
the Cloudflare token before August 2, 2027 and replace the corresponding secret
in all three GitHub environments without changing binding names.

## Source map

- Infrastructure stack: `infra/cloud/alchemy.run.ts`
- Stage policy: `infra/cloud/src/environments.ts`
- Better Auth schema: `apps/api/src/db/schema.ts`
- Committed migrations: `infra/cloud/migrations/postgres/`
- Cloud application boundary: `apps/api/`
- CI verification: `.github/workflows/`
- Release readiness: `docs/operations/releases.md`
