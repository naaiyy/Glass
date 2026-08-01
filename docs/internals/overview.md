# System overview

> **Audience:** Glass maintainers and contributors.

Glass has two independent connections: an always-on product connection to Glass Cloud and an optional execution connection to a capable computer or cloud environment.

The product connection owns identity, organizations, projects, artifacts, conversations, shared documents, collaboration, synchronization, and durable product state. The execution connection owns access to filesystems, repositories, terminals, processes, local agent runtimes, Git, browser automation, and workspace checkpoints.

Execution loss never makes the product unavailable. The clients continue to read and write cloud-owned product state, show the environment as unavailable, preserve eligible device-owned drafts in the outbox, and disable only actions that require machine capabilities.

## Runtime boundaries

- `apps/api` is the always-on product authority at the Cloudflare Worker boundary. It never spawns local processes or accesses a user workspace.
- `apps/execution-node` runs on an execution environment and advertises machine capabilities. The foundation exposes only a typed capability descriptor.
- `packages/execution-core` contains execution domain/orchestration logic. It is not a running service.
- `apps/web` and `apps/mobile` are product clients. `apps/desktop` hosts the same renderer as web and adds a secure Electron boundary.
- `packages/contracts`, `packages/domain`, and `packages/client-runtime` carry typed behavior shared across surfaces without merging their platform responsibilities.

## Implemented boundary

The foundation supplies runnable application boundaries, package boundaries, shared contracts, verification, and documentation. It does not supply durable product storage, login, collaboration, environment pairing, terminal/filesystem operations, managed tunnels, or production deployment.

## Source map

- Product API boundary: `apps/api/src/index.ts`
- Execution runtime boundary: `apps/execution-node/src/main.ts`
- Web renderer: `apps/web/src/`
- Desktop host and preload: `apps/desktop/src/`
- Mobile client: `apps/mobile/src/`
- Cross-boundary contracts: `packages/contracts/src/`
- Product domain: `packages/domain/src/`
- Client connection runtime: `packages/client-runtime/src/`
- Execution orchestration domain: `packages/execution-core/src/`
