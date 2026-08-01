# Cloud infrastructure

This page is for Glass infrastructure and service operators.

## Current status

The foundation defines the cloud application boundary and reserves `infra/cloud` for declarative infrastructure. It does not provision, deploy, or configure a production Glass Cloud environment. No local or in-memory service substitutes for missing durable infrastructure.

## Target service ownership

The cloud milestone may use Cloudflare Workers, Durable Objects, Queues, Hyperdrive, and R2; PlanetScale Postgres with Drizzle; Better Auth; DNS; and Vercel where each service has a clear ownership boundary. Selection in the architecture does not mean a service is currently operational.

Operators require real accounts, environment identifiers, DNS authority, database and object-storage configuration, authentication secrets, encryption/signing material, and deployment credentials before enabling production paths. If any authority is missing, deployment stops and requests it rather than installing a fake integration.

## Operational requirements

- Separate development, staging, and production resources and credentials.
- Keep secrets out of source control, build logs, client bundles, and generated artifacts.
- Apply least-privilege service bindings and rotate credentials.
- Treat database migrations, queue compatibility, object retention, backup, restore, and regional behavior as release gates.
- Monitor API availability independently from execution connectivity.
- Preserve product availability during execution-node and tunnel outages.
- Validate authentication, authorization, rate limits, auditability, and data retention before production exposure.
- Document recovery objectives and prove restore procedures before claiming durable service readiness.

## Source map

- Future infrastructure declarations: `infra/cloud/`
- Cloud application boundary: `apps/api/`
- CI verification: `.github/workflows/`
- Release readiness: `docs/operations/releases.md`
