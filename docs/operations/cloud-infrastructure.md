# Cloud infrastructure

> Audience: Glass infrastructure and release operators.

## Current topology

`infra/cloud` declares two retained environments. Local development is not a third deployment: it
uses Docker PostgreSQL and Wrangler's local Worker runtime.

| Environment | Worker                                                         | Database ownership                                  |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------- |
| production  | `glasscloud-api-prod-lcuxsmngpdigrgum.naaiyyyy.workers.dev`    | PlanetScale database and `main` branch              |
| staging     | `glasscloud-api-staging-rmhiqpuua7m4g6a3.naaiyyyy.workers.dev` | isolated `PS_DEV` branch of the production database |

The deployed origins used by packaged clients live in `config/glass-cloud.json`. Local origins are
derived by `scripts/local-runtime.mjs` and never enter that deployed-origin registry.

## Resource graph

Both stages apply the same committed migration chain. Better Auth generates
`apps/api/src/db/auth-schema.generated.ts`; `apps/api/src/db/schema.ts` composes it with Glass-owned
tables before Drizzle generates migrations.

Each stage owns:

- a data-only PlanetScale runtime role and Cloudflare Hyperdrive connection
- a public API Worker and static web assets
- a `CONNECT_AUTHORITY` Durable Object namespace
- three Glass Connect rate-limit namespaces
- a private tunnel-control Worker and service binding
- independent Better Auth, GitHub OAuth, and Connect ticket secrets

Production runs in `eu-central` on `PS_5_AWS_X86` with two replicas. Staging uses `PS_DEV` with zero
replicas. Hyperdrive query caching is disabled and its origin pool is capped at 20 connections per
stage.

Tunnel and DNS provider credentials remain confined to the private tunnel-control Worker. The
Cloudflare Tunnel credential is account-scoped to Tunnel Write; DNS uses a separate zone-scoped
token. Neither credential grants Glass product authority or enters the public API Worker.

## Reconciliation contract

- Bootstrap `prod` before staging because cross-stage references require the production database.
- Generate and review Better Auth schema and Drizzle migrations before apply.
- Review an explicit plan for `prod` and `staging`; there is no generic or development deploy entry.
- Keep provider credentials, database passwords, OAuth secrets, and signing material out of source,
  logs, URLs, outputs, fixtures, and client bundles.
- Verify Worker-to-Hyperdrive-to-PlanetScale connectivity and the complete authentication lifecycle
  after every deployment.
- Require an idempotent second plan after apply.

## Commands

```text
vp run --filter @glass/api auth:schema
vp run --filter @glass/api db:migrations
vp run --filter @glass/cloud-infrastructure plan:prod
vp run --filter @glass/cloud-infrastructure deploy:prod
vp run --filter @glass/cloud-infrastructure plan:staging
vp run --filter @glass/cloud-infrastructure deploy:staging
```

After an apply, inspect the migration table, runtime grants, Hyperdrive configuration, Worker
bindings, health endpoint, sign-in callback, session persistence, sign-out, publishing, direct
execution, revocation, and provider cleanup.

## GitHub Actions

The manually dispatched `Glass Cloud` workflow accepts only `staging` and `production`. Each GitHub
environment holds its own Cloudflare token, PlanetScale token, Better Auth secret, Connect ticket
secret, tunnel credentials, and OAuth credentials. GitHub reserves the `GITHUB_` prefix, so OAuth
values are stored as `OAUTH_GITHUB_CLIENT_ID` and `OAUTH_GITHUB_CLIENT_SECRET` and mapped by the
workflow.

Production protection rules remain a GitHub authorization boundary. Rotate the Cloudflare CI token
before August 2, 2027 and update both retained GitHub environments without changing binding names.

## Local development

Local development uses the same Worker entry, contracts, schema, and migration chain. It stores
product data in an isolated Docker volume and Worker state under `.glass-local/<instance>`. Its only
remote Cloudflare dependency is an explicit service binding to staging's private tunnel-control
Worker so managed Glass Connect tunnel provisioning remains testable end to end. See
[Development runtime](../internals/development-runtime.md).

## Source map

- Infrastructure stack: `infra/cloud/alchemy.run.ts`
- Deployed origins: `config/glass-cloud.json`
- Stage policy: `infra/cloud/src/environments.ts`
- Local runtime: `infra/local/`, `scripts/local-runtime.mjs`
- Committed migrations: `infra/cloud/migrations/postgres/`
- CI workflow: `.github/workflows/cloud.yml`
- Release readiness: `docs/operations/releases.md`
