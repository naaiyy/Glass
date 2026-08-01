# Glass Connect

> **Audience:** Glass maintainers and contributors working on managed remote execution connectivity.

Glass Connect is the future managed transport between Glass Cloud and an authenticated execution node. It preserves the separation between the always-on product connection and optional execution connection.

## Contract

Glass Connect provides discovery and transport, not product authority. Glass Cloud remains authoritative for users, projects, conversations, documents, environment registry, pairing, and durable execution metadata/results. The execution environment remains authoritative for workspaces, processes, provider credentials, and checkpoints.

The design requires real user authentication, scoped environment credentials, DPoP-style proof of possession, short-lived WebSocket tickets, and managed tunnels. Authorization is evaluated independently of transport. A tunnel cannot widen project, workspace, or capability scope.

## Failure behavior

- When Glass Connect is unavailable, the product connection and cloud-owned product state remain usable.
- The UI reports the affected environment as unavailable and does not substitute another node.
- Operations never report completion merely because transport accepted a frame.
- Reconnection re-establishes authentication and reconciles durable operation state; it does not reuse an expired ticket.
- Direct or local transports, if later supported, implement the same contracts and authorization requirements.

## Foundation status

Glass Connect, pairing, credential exchange, WebSocket tickets, and tunnels are not implemented in the foundation. No placeholder endpoint or fake token flow stands in for them.

## Source map

- Future transport and authentication contracts: `packages/contracts/src/`
- Future control-plane boundary: `apps/api/src/`
- Future node transport adapter: `apps/execution-node/src/`
- Shared client connection state: `packages/client-runtime/src/`
- Future cloud declarations: `infra/cloud/`
