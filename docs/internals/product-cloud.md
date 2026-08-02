# Product cloud

> **Audience:** Glass maintainers and contributors working on cloud-owned product behavior.

Glass Cloud is the durable product authority. It remains reachable independently of any execution environment.

## Ownership

Glass Cloud owns:

- users and sessions
- organizations and authorization membership
- projects and artifacts
- threads and messages
- note artifact identity, metadata, and durable OpenEditor payloads through the editor storage boundary
- notifications
- the environment registry and pairing records
- durable execution metadata and results

A project is a cloud record. It can refer to zero or more execution workspaces without becoming a directory. A thread remains readable when its last execution environment is offline. Durable execution results remain cloud-owned even when the workspace that produced them is unavailable.

## API boundary

`apps/api` is a Cloudflare Worker boundary. It validates requests and responses with shared
contracts, authenticates the caller with Better Auth, authorizes access against active cloud-owned
membership, and coordinates durable cloud services.

The API does not import execution-only packages, access user files, spawn commands, load provider
credentials, or treat an execution node as its database. The deployed Milestone 2 foundation uses
Cloudflare Workers, Hyperdrive, PlanetScale Postgres, Drizzle, and Better Auth. Milestone 3 uses
that durable boundary for canonical product tables and a transactional change log; it does not add
binary product uploads. The Worker also serves the shared web renderer as static assets, keeping
browser authentication and product requests on one origin. Native mobile and packaged desktop use
the official Better Auth platform integrations rather than browser-cookie assumptions.

OpenEditor is the only editor implementation. Glass Cloud may authenticate, authorize, and store
the native OpenEditor payload through a dedicated adapter, but generic artifact JSON, product
events, snapshots, and the device outbox never carry editor content. See
[OpenEditor integration](openeditor.md).

## Availability rule

Cloud product operations do not acquire a dependency on execution availability. A feature that requires both sides stores its durable intent in cloud state, reports execution availability separately, and uses explicit terminal states for accepted, running, completed, failed, cancelled, or unavailable work.

## Source map

- Worker boundary: `apps/api/src/index.ts`
- Product contracts: `packages/contracts/src/`
- Domain rules and errors: `packages/domain/src/`
- Durable product model: `docs/internals/durable-product-core.md`
- Synchronization model: `docs/internals/synchronization.md`
- Editor boundary: `docs/internals/openeditor.md`
- Infrastructure declarations: `infra/cloud/`
