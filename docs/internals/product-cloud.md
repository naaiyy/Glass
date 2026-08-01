# Product cloud

> **Audience:** Glass maintainers and contributors working on cloud-owned product behavior.

Glass Cloud is the durable product authority. It remains reachable independently of any execution environment.

## Ownership

Glass Cloud owns:

- users and sessions
- organizations and authorization membership
- projects and artifacts
- threads and messages
- shared documents and uploads
- notifications
- the environment registry and pairing records
- durable execution metadata and results

A project is a cloud record. It can refer to zero or more execution workspaces without becoming a directory. A thread remains readable when its last execution environment is offline. Durable execution results remain cloud-owned even when the workspace that produced them is unavailable.

## API boundary

`apps/api` is a Cloudflare Worker boundary. It validates requests and responses with shared contracts, authenticates the caller once authentication exists, authorizes access against cloud-owned membership, and coordinates durable cloud services.

The API does not import execution-only packages, access user files, spawn commands, load provider credentials, or treat an execution node as its database. Later cloud infrastructure may add Workers, Durable Objects, Queues, Hyperdrive, R2, PlanetScale Postgres, Drizzle, and Better Auth. None is operational in the foundation.

## Availability rule

Cloud product operations do not acquire a dependency on execution availability. A feature that requires both sides stores its durable intent in cloud state, reports execution availability separately, and uses explicit terminal states for accepted, running, completed, failed, cancelled, or unavailable work.

## Source map

- Worker boundary: `apps/api/src/index.ts`
- Product contracts: `packages/contracts/src/`
- Domain rules and errors: `packages/domain/src/`
- Future infrastructure declarations: `infra/cloud/`
