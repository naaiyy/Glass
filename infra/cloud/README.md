# Glass Cloud infrastructure

This workspace declares the Milestone 2 Cloudflare and PlanetScale foundation.
Provider resources change only through an explicit Alchemy deployment.

## Conventions

- The Alchemy stack is `GlassCloud`.
- Long-lived stages are `prod`, `staging`, and shared `dev`. Personal local
  development uses Alchemy's default `dev_$USER` stage.
- Alchemy generates every physical database, branch, role, Hyperdrive, and
  Worker name from the stack, stage, and logical resource ID. The source does
  not duplicate those provider naming rules.
- `prod` owns the retained PlanetScale Postgres database and its default `main`
  branch. Every other stage references that resource with `Resource.ref` and
  owns an isolated branch.
- Production is in `eu-central` with `PS_5_AWS_X86` and two replicas. Staging
  and development branches use `PS_DEV` with zero replicas. Shared staging and
  development are retained; personal development branches are disposable.
- The Worker uses Cloudflare's standard `HYPERDRIVE` binding and Better Auth's
  standard `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, and
  `GITHUB_CLIENT_SECRET` configuration names. Better Auth scopes dynamic base
  URL resolution to the generated Worker host for the active Alchemy stage.
- The same Worker serves the built web renderer. Authentication, product, and
  health paths execute Worker code before static asset handling.
- Hyperdrive query caching is disabled for correctness-sensitive auth data and
  each environment has an explicit 20-connection origin ceiling.

Better Auth's CLI generates only `apps/api/src/db/auth-schema.generated.ts`.
`apps/api/src/db/schema.ts` composes those generated tables with Glass-owned
product tables. Stable Drizzle Kit in `apps/api` generates the committed SQL and metadata in
`infra/cloud/migrations/postgres`. Alchemy's PlanetScale provider applies that
same migration chain to the selected branch using a temporary migration role.
The persistent runtime role is data-only (`pg_read_all_data` and
`pg_write_all_data`). Each environment branch is an exclusive Glass database
boundary rather than a shared database with unrelated application tables, so
this role intentionally covers every current and future Glass table in that
branch while remaining unable to administer the database, roles, or schema.

## Schema and migration workflow

```text
vp run --filter @glass/api auth:schema
vp run --filter @glass/api db:migrations
git diff -- apps/api/src/db/auth-schema.generated.ts apps/api/src/db/schema.ts infra/cloud/migrations/postgres
```

Never point the Better Auth generator at the composed schema. Review and commit the generated
auth schema, composed schema, SQL, snapshot, and journal together. Ambiguous
renames and destructive changes require an explicit human decision.

## Plan and deploy

The production database must exist before another stage can reference it:

```text
vp run --filter @glass/cloud-infrastructure plan:prod
vp run --filter @glass/cloud-infrastructure deploy:prod
vp run --filter @glass/cloud-infrastructure plan:staging
vp run --filter @glass/cloud-infrastructure deploy:staging
vp run --filter @glass/cloud-infrastructure plan:dev
vp run --filter @glass/cloud-infrastructure deploy:dev
vp run --filter @glass/cloud-infrastructure plan
vp run --filter @glass/cloud-infrastructure deploy
```

The unqualified commands intentionally use Alchemy's personal default stage.
Deploy commands omit `--yes` and adoption flags so the operator reviews every
provider change. `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, and
`GITHUB_CLIENT_SECRET` must be present in the deployment environment; secret
values never appear in source or stack outputs. Each stage uses an independent
32-byte Better Auth secret supplied through its GitHub environment.
