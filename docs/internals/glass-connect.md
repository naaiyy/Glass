# Glass Connect

> **Audience:** Glass maintainers and contributors working on managed remote execution connectivity.

Glass Connect is the managed, authenticated path between a Glass client and a published execution
environment. Each environment has a remotely managed Cloudflare Tunnel and a stage-scoped proxied
DNS hostname. The execution node initiates the connector and exposes only a loopback HTTP/WebSocket
origin. After authorization, execution traffic travels directly from the client through that
tunnel to the node; Glass Cloud is the control plane and durable authority and does not forward
execution frames.

## Ownership and supported path

Glass Cloud owns users, organizations, discovery, the environment registry, pairing, tunnel
allocation, authorization, durable operation intent, and durable results. The execution environment
owns its workspaces, processes, provider credentials, checkpoints, private key, loopback origin, and
connector process. Cloudflare supplies encrypted reachability and proxied DNS. Tunnel reachability
never grants authority.

Glass Connect is the only initially supported execution transport. SSH launch, direct LAN
endpoints, Tailscale-specific transport, user-managed tunnels, and manually entered execution URLs
are not production paths or verification substitutes.

Publishing and sign-in are separate actions:

1. A user signs into Glass Cloud and can discover environments already published to organizations
   they may access.
2. On a capable computer, the user explicitly starts Glass Connect. If the computer is not already
   published, the launcher displays a one-time code. In **Settings → Environments**, an organization
   administrator enters that code. Pairing makes the environment available to all organization
   projects and supported capabilities; there are no access choices in this flow.
3. The node proves possession of its environment-held Ed25519 key and obtains a short-lived,
   audience-bound credential.
4. Without requiring another command, the node binds an HTTP/WebSocket origin to `127.0.0.1`, requests tunnel configuration with a
   fresh DPoP-style proof, and supervises the pinned, checksum-verified connector. A missing or
   revoked environment identity is terminal for that connector. Starting Glass Connect again
   creates a fresh publication ceremony instead of retrying it as a transient network failure.
5. Glass Cloud creates or reconciles one remotely managed tunnel and proxied DNS record for that
   environment and stage. The only ingress maps the environment hostname to the loopback origin;
   unmatched requests receive `404`.
6. Authorized clients discover the hostname and honest presence state. Users never enter or copy
   the execution endpoint.

## Connection and dispatch protocol

The client first asks Glass Cloud for a short-lived, organization- and environment-scoped ticket.
It opens the environment WebSocket using `glass-connect-v2` and an opaque one-time ticket in the
`Sec-WebSocket-Protocol` list. Tickets do not appear in a URL. Before returning `101 Switching
Protocols`, the loopback node asks Glass Cloud to consume the ticket while authenticating with its
current credential and a fresh proof. Consumption is atomic, expiry-checked, generation-bound, and
key-version-bound.

The node then sends a welcome containing fresh nonces and the accepted ticket/session claims,
signed with the current Ed25519 environment key. The client verifies the signature against the
cloud-discovered public key before sending work. A WebSocket, tunnel token, public hostname, or
successful handshake alone is not a capability grant.

Every operation begins as authorized durable cloud intent. Before any machine side effect, the node
submits the session and exact typed frame under a fresh environment proof. Glass Cloud claims the
matching durable operation and validates organization, environment, workspace binding, capability,
request digest, environment key version, and cancellation state. Duplicate delivery is expected;
the durable operation identifier and node journal make handling idempotent.

A claimed operation is never automatically transferred to a new client session after an ambiguous
disconnect: Glass cannot prove that a machine side effect did not already happen. The original
durable claim continues accepting journaled results under current node proof even when its client
socket is gone, and reconnecting clients read the durable operation state. Only an unclaimed queued
intent may be dispatched. If no durable result arrives, the operation remains explicitly
interrupted/unknown and a user must create a new operation to retry; reconnect never silently
re-executes it.

The node streams typed frames directly to the client, but persists each frame through Glass Cloud
before forwarding it. A frame remains in the environment-owned delivery journal until Cloud
acknowledges the durable record. A terminal operation is complete only when its durable result is
recorded, not when a socket write succeeds. Presence and the bounded workspace catalog are
published under the same proof-bound node authority. Heartbeats expire to an honest offline state.

## Revocation and failure

- Revocation transactionally removes execution authority and schedules forced connector cleanup.
  The node stops its connector and loopback origin; the control plane deletes the remotely managed
  tunnel and proxied DNS allocation. Cleanup is durable and retryable after a partial provider
  failure.
- Reconnect obtains fresh proof-bound tunnel configuration, re-establishes presence, uses a new
  one-time client ticket, reads durable operation state, and reconciles unacknowledged result
  frames without redispatching an already claimed operation.
- When Glass Connect is unavailable, Glass Cloud and cloud-owned product state remain usable. The
  UI reports only the affected execution environment as unavailable and never silently chooses a
  different environment or transport.
- Interrupted work never becomes successful merely because transport accepted a frame. Cancellation
  and terminal errors remain explicit durable outcomes.

## Operational status

The tunnel control plane, direct client transport, loopback node origin, connector supervision,
proof-bound authority, durable dispatch and result acknowledgement, and web, desktop, and native
mobile integrations are implemented. Staging and production use the delegated `glassapp.dev` zone
and isolated resources. Local development uses local cloud authority with an explicit remote binding
to staging's tunnel-control service. Production has passed live tunnel creation,
proxied DNS, connector startup, direct ticketed WebSocket execution, durable result recovery,
revocation, and provider cleanup. No local mock, quick tunnel, user-managed endpoint, or
alternate transport is part of this path.

## Source map

- Environment identity contracts: `packages/contracts/src/environments.ts`
- Glass Connect and tunnel contracts: `packages/contracts/src/connect.ts`, `packages/contracts/src/connect-tunnel.ts`
- Environment trust boundary: `apps/api/src/environment-service.ts`
- Ticket/dispatch authority and durable tunnel lifecycle: `apps/api/src/connect-authority.ts`, `apps/api/src/tunnel-service.ts`
- API ingress and durable execution service: `apps/api/src/index.ts`, `apps/api/src/execution-service.ts`
- Loopback origin, connector control, and frame journal: `apps/execution-node/src/tunnel-origin.ts`, `apps/execution-node/src/tunnel-control.ts`, `apps/execution-node/src/cloudflared.ts`, `apps/execution-node/src/frame-delivery-journal.ts`
- Shared client connection state: `packages/client-runtime/src/glass-connect-client.ts`
- Web and mobile integrations: `apps/web/src/product-cloud/`, `apps/mobile/src/`
- Durable schema and migrations: `apps/api/src/db/schema.ts`, `infra/cloud/migrations/postgres/`
- Cloudflare tunnel, DNS, authority, and Worker declarations: `infra/cloud/alchemy.run.ts`, `infra/cloud/src/tunnel-control-worker.ts`
