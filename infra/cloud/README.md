# Glass Cloud infrastructure

This workspace declares the retained Cloudflare and PlanetScale foundation. Provider resources
change only through an explicit Alchemy deployment.

## Conventions

- The Alchemy stack is `GlassCloud`.
- The only deployed stages are `prod` and `staging`.
- Local development runs the Worker and PostgreSQL locally; it is not an Alchemy stage or a
  PlanetScale branch.
- `prod` owns the retained PlanetScale Postgres database and its default `main` branch. `staging`
  references that database and owns an isolated `PS_DEV` branch.
- Production runs in `eu-central` on `PS_5_AWS_X86` with two replicas. Staging uses `PS_DEV` with
  zero replicas.
- Every physical resource name is generated from the stack, stage, logical resource ID, and
  instance identity. Source does not duplicate provider naming rules.
- Each stage has independent Better Auth, GitHub OAuth, and Glass Connect secrets.
- The public API binds a private tunnel-control Worker. Provider tunnel and DNS credentials remain
  confined to that private service and confer no Glass product authority.
- The Worker binds the `CONNECT_AUTHORITY` Durable Object for proof freshness and ticket generation;
  execution frames travel directly through each environment tunnel.
- Hyperdrive query caching is disabled and each stage has an explicit 20-connection origin ceiling.

Better Auth's CLI generates only `apps/api/src/db/auth-schema.generated.ts`.
`apps/api/src/db/schema.ts` composes it with Glass-owned tables. Drizzle generates the committed SQL
and metadata in `infra/cloud/migrations/postgres`; Alchemy applies the same chain to the selected
PlanetScale branch.

## Schema and migration workflow

```text
vp run --filter @glass/api auth:schema
vp run --filter @glass/api db:migrations
git diff -- apps/api/src/db/auth-schema.generated.ts apps/api/src/db/schema.ts infra/cloud/migrations/postgres
```

Review the generated auth schema, composed schema, SQL, snapshot, and journal together.

## Plan and deploy

Production must exist before staging can reference it:

```text
vp run --filter @glass/cloud-infrastructure plan:prod
vp run --filter @glass/cloud-infrastructure deploy:prod
vp run --filter @glass/cloud-infrastructure plan:staging
vp run --filter @glass/cloud-infrastructure deploy:staging
```

Deploy commands omit `--yes` for local operators. GitHub Actions uses the stage-specific CI entries.
After deployment, require an idempotent plan and verify health, sign-in, persistence, publishing,
direct WebSocket execution, revocation, and provider cleanup.

## Local development

The local runtime lives in `infra/local` and `scripts/local-*.mjs`. It deliberately does not use
this infrastructure graph. Its one remote dependency is an explicit service binding to staging's
private tunnel-control Worker so managed Connect tunnel provisioning can be tested end to end.
