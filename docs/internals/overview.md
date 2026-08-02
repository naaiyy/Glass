# System overview

> **Audience:** Glass maintainers and contributors.

Glass has two independent connections: an always-on product connection to Glass Cloud and an optional execution connection to a capable computer or cloud environment.

The product connection owns identity, organizations, projects, artifacts, conversations, note storage, collaboration, synchronization, and durable product state. The execution connection owns access to filesystems, repositories, terminals, processes, local agent runtimes, Git, browser automation, and workspace checkpoints.

Notes use OpenEditor on every supported surface. Glass owns their product identity and the
authenticated durable adapter around the native OpenEditor payload. OpenEditor owns the document
model, editing behavior, and future editor collaboration. Glass product synchronization does not
duplicate editor synchronization.

Execution loss never makes the product unavailable. The clients continue to read and write
cloud-owned product state, show the environment as unavailable, preserve queued Glass product
mutations in the device outbox, and disable only actions that require machine capabilities.
OpenEditor content does not enter that outbox; the editor reports an unsuccessful save and keeps
the current editing session available for explicit retry.

## Runtime boundaries

- `apps/api` is the always-on product authority at the Cloudflare Worker boundary. It never spawns local processes or accesses a user workspace.
- `apps/execution-node` runs on an execution environment and advertises machine capabilities. The foundation exposes only a typed capability descriptor.
- `packages/execution-core` contains execution domain/orchestration logic. It is not a running service.
- `apps/web` and `apps/mobile` are product clients. `apps/desktop` hosts the same renderer as web and adds a secure Electron boundary.
- `packages/contracts`, `packages/domain`, and `packages/client-runtime` carry typed behavior shared across surfaces without merging their platform responsibilities.

## Implemented boundary

Milestones 0 through 2 supply runnable application and package boundaries, real Glass Cloud
authentication, deployed cloud infrastructure, and the durable database connection. Milestone 3
adds organization-scoped product state, transactional change events, synchronization, and
device-owned outbox behavior. Its migrations, routes, shared web renderer, and GitHub authentication
entry are deployed in development, staging, and production; the production web authentication and
product-only flow have passed live verification.

The web client initiates GitHub authentication directly against Better Auth on the same deployed
Worker origin. Mobile uses Better Auth's Expo deep-link integration and device-secure cookie
storage. Packaged desktop uses Better Auth's Electron PKCE handoff through the system browser;
session material remains in the main process, and an allowlisted IPC adapter performs authenticated
product requests without exposing cookies to the renderer. No surface substitutes a local identity
or pre-seeded credential.

Environment pairing, terminal/filesystem operations, managed tunnels, production-ready
multi-user chat and product experiences, and releases remain later milestones. Editor
collaboration is not implemented by Glass at a later milestone; OpenEditor owns that capability.

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
