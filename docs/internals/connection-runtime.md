# Connection runtime

> **Audience:** Glass maintainers and contributors working on client connectivity and synchronization.

Every client models two independent connections.

## Product connection

The product connection targets Glass Cloud and carries authenticated access to cloud-owned state. It is the primary application connection. Its lifecycle includes connecting, online, reconnecting, offline, and signed-out states.

## Execution connection

The execution connection targets an authorized execution environment, directly or through future Glass Connect transport. Its lifecycle is subordinate only to features requiring machine capabilities. Disconnection does not sign the user out, remove projects, hide cloud-owned threads, or turn the entire client offline.

## State rules

- Connection state is explicit and observable; a failed execution connection never silently falls back to a different node.
- Retries are bounded and use backoff with jitter.
- Duplicate and out-of-order delivery is expected across reconnects. Durable operations use stable identifiers and idempotent handling.
- Device-owned drafts and outbox items remain distinguishable from cloud-confirmed records.
- UI state derives product and execution availability separately. A single combined `connected` flag is invalid.
- Contracts crossing HTTP, WebSocket, desktop IPC, or a future tunnel are validated at ingress.

Milestone 3 adds typed snapshot/pull synchronization and a device-owned durable outbox to the shared
runtime. It does not add Glass Connect or make realtime socket transport a correctness dependency.
See [Product synchronization and outbox](synchronization.md).

## Source map

- Shared client runtime: `packages/client-runtime/src/`
- Wire contracts: `packages/contracts/src/`
- Web integration: `apps/web/src/`
- Desktop preload boundary: `apps/desktop/src/`
- Mobile integration: `apps/mobile/src/`
- Cloud boundary: `apps/api/src/`
- Execution boundary: `apps/execution-node/src/`
