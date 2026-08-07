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
- `apps/execution-node` runs on an execution environment, advertises its implemented machine capabilities, and handles typed operations through Glass Connect.
- `packages/execution-core` contains execution domain/orchestration logic. It is not a running service.
- `apps/web` and `apps/mobile` are product clients. `apps/desktop` hosts the same renderer as web and adds a secure Electron boundary.
- `packages/contracts`, `packages/domain`, and `packages/client-runtime` carry typed behavior shared across surfaces without merging their platform responsibilities.

## Implemented boundary

Runnable application and package boundaries, real Glass Cloud authentication, deployed cloud
infrastructure, and the durable database connection supply the product foundation. Glass Cloud
adds organization-scoped product state, transactional change events, synchronization, and
device-owned outbox behavior. Its migrations, routes, shared web renderer, and GitHub authentication
entry are deployed in staging and production and run locally during development; production web authentication and
cloud-owned product flow have passed live verification.

Environment trust supplies durable organization-owned execution-environment identities, explicit
administrator approval, environment-held Ed25519 proof, short-lived proof-bound credentials,
revocation, and append-only security audit events. The web renderer exposes approval,
listing, and revocation; the execution node owns its private identity and performs the pairing proof.
Glass Connect and the execution runtime add the managed outbound per-environment Cloudflare Tunnel, authenticated presence and workspace
discovery, generation-bound one-time connection tickets, typed dispatch, durable operation intent
and results, files, commands, terminal/PTY, Git, checkpoints, streaming, reconnect, and bounded
cancellation. The execution data path is direct from a client through the proxied tunnel hostname to
the node's loopback origin; Glass Cloud remains the control plane and durable authority. These
paths are deployed in staging and production and have passed live production trust,
tunnel, direct WebSocket, durable-result, and cleanup verification.

The web client initiates GitHub authentication directly against Better Auth on the same Worker
origin. During local development, Vite preserves that same-origin client model while proxying to the
locally running Worker and PostgreSQL database. Mobile uses Better Auth's Expo deep-link integration and device-secure cookie
storage. Packaged desktop uses Better Auth's Electron PKCE handoff through the system browser;
session material remains in the main process, and an allowlisted IPC adapter performs authenticated
product requests without exposing cookies to the renderer. No surface substitutes a local identity
or pre-seeded credential.

Production-ready multi-user chat and product experiences and releases remain later gates. Glass
Connect is the only initial execution transport; SSH launch,
direct LAN endpoints, Tailscale-specific transport, user-managed tunnels, and manually entered
execution URLs are not initial paths. Editor
collaboration is not implemented by Glass at a later milestone; OpenEditor owns that capability.

## Source map

- Product API boundary: `apps/api/src/index.ts`
- Environment trust service: `apps/api/src/environment-service.ts`
- Environment schema: `apps/api/src/db/schema.ts`
- Environment wire contracts: `packages/contracts/src/environments.ts`
- Node-held identity: `apps/execution-node/src/identity.ts`
- Publishing UI and client adapter: `apps/web/src/product-cloud/EnvironmentSettings.tsx`, `apps/web/src/product-cloud/EnvironmentDirectory.tsx`, `apps/web/src/product-cloud/environment-cloud.ts`
- Execution runtime boundary: `apps/execution-node/src/main.ts`
- Tunnel control and durable authority: `apps/api/src/tunnel-service.ts`, `apps/api/src/connect-authority.ts`
- Loopback tunnel origin and connector supervisor: `apps/execution-node/src/tunnel-origin.ts`, `apps/execution-node/src/cloudflared.ts`
- Web renderer: `apps/web/src/`
- Desktop host and preload: `apps/desktop/src/`
- Mobile client: `apps/mobile/src/`
- Cross-boundary contracts: `packages/contracts/src/`
- Product domain: `packages/domain/src/`
- Client connection runtime: `packages/client-runtime/src/`
- Execution orchestration domain: `packages/execution-core/src/`
