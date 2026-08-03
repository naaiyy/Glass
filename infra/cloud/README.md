# Glass Cloud infrastructure

This workspace declares the Cloudflare and PlanetScale foundation.
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
- Glass Connect uses an independent `CONNECT_TICKET_SECRET` to sign short-lived
  transport tickets and operation dispatch grants. Each GitHub environment
  supplies a different secret of at least 32 random bytes; it is required for
  plan, deploy, and post-deploy convergence checks and is never committed.
- `CONNECT_TUNNEL_ZONE_NAME` selects an active Cloudflare DNS zone. Each environment receives a
  deterministic, stage-scoped hostname with a proxied CNAME to its remotely managed tunnel.
- A private `TUNNEL_CONTROL` Worker receives least-privilege runtime Tunnel Write and zone-scoped
  DNS Write bindings. The public API cannot turn those provider credentials into client authority.
- A Cloudflare account token scoped only to Tunnel Write is confined to the private control Worker
  and performs tunnel creation, configuration, token retrieval, forced connection cleanup, and
  deletion through the provider API. DNS remains a separate zone-scoped binding. Neither provider
  credential is exposed to the public API Worker or a client.
- The Worker binds the `CONNECT_AUTHORITY` Durable Object namespace for proof freshness and ticket
  generation only; execution frames travel directly through the per-environment tunnel. It also
  binds three stage-isolated Cloudflare Rate Limit namespaces. `TRUST_MUTATION_RATE_LIMIT` allows 20 environment-trust
  mutations per minute; `TRUST_POLL_RATE_LIMIT` allows 120 pairing or rotation status polls per
  minute. `CONNECT_NODE_RATE_LIMIT` allows 10,000 authenticated node-control requests per minute,
  keyed by the verified environment and credential rather than an IP address, so streamed result
  persistence cannot exhaust pairing capacity.
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
provider change. `BETTER_AUTH_SECRET`, `CONNECT_TICKET_SECRET`, `CONNECT_TUNNEL_ZONE_NAME`,
`GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` must be present in the deployment environment. The
selected zone must already be active and delegated, and the deploying Cloudflare identity must be
authorized to provision the Worker, Durable Object, service binding, runtime Tunnel token, and
zone-scoped DNS token. Secret values never appear in source or stack outputs. Each stage uses an independent
32-byte Better Auth secret supplied through its GitHub environment.

After deployment, require an idempotent second plan, then publish a disposable environment and
verify tunnel creation, proxied DNS, ingress-to-loopback configuration, direct cross-device
WebSocket execution, durable result acknowledgement, reconnect, rotation, revocation, and provider
cleanup. Production has passed this live provider and transport proof; repeat it after changes to
trust, tunnels, DNS, connection authority, or durable execution delivery.
