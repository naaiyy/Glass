# Glass

Glass is an always-available cloud product with optional connections to execution environments.
This repository implements the architectural constitution, runnable monorepo, deployed Glass Cloud,
durable product core, environment identity, Glass Connect, and execution capabilities across five
applications and six boundary-focused packages.

Milestone 3 adds organization-scoped durable product records, typed synchronization, and a
device-owned offline outbox without making execution a product dependency. The shared web renderer,
Better Auth entry, and durable product API are deployed together in development, staging, and
production and have passed live authentication verification. Environment publishing now uses
durable organization-owned records, environment-held Ed25519 keys, explicit administrator
approval, proof-bound short-lived credentials, rotation, revocation, and security audit events.
Environment publishing, proof-bound credentials, managed per-environment Cloudflare Tunnels,
stage-scoped proxied DNS, a loopback node origin, direct client WebSockets, key rotation, and durable
dispatch/results are deployed in development, staging, and production. The production path has
passed live publishing, managed-tunnel, direct WebSocket, durable-result, rotation, and cleanup
verification.
Production-ready multi-user product experiences and releases remain later completion gates. Editor
collaboration is not one of those Glass milestones:
OpenEditor owns it, and Glass adopts it through a coordinated OpenEditor dependency update.

The execution sequence establishes environment publishing, managed Glass Connect connectivity, then
machine capabilities through that authenticated path. Glass
Connect is the only initial execution transport. SSH launch, direct LAN endpoints,
Tailscale-specific transport, user-managed tunnels, and manually entered execution URLs are not
initially supported.

## Workspaces

- `apps/web` — shared Vite and React renderer
- `apps/desktop` — secure Electron host for the web renderer
- `apps/mobile` — native Expo 57 client with React Navigation
- `apps/api` — Cloudflare Worker product boundary
- `apps/execution-node` — Node and Effect execution boundary
- `packages/*` — explicit contracts, domain, runtime, UI, shared, and execution boundaries

See [docs/README.md](docs/README.md) for architecture and operations documentation. Repository rules live in [AGENTS.md](AGENTS.md).

## Development

Install the global `vp` command from the [Vite Plus guide](https://viteplus.dev/guide/), then use the repository workflow:

```sh
vp i
vp check
vpr typecheck
vp run test
vp run build
```

Focused development tasks are exposed through the root package, including `vp run dev:web`, `vp run dev:desktop`, `vp run dev:mobile`, `vp run dev:api`, and `vp run dev:execution-node`.

## Publish an execution environment

Build the node, begin pairing, then approve the printed code while signed in to the same Glass
Cloud origin. The approval link opens the deployed single-page renderer at the Glass Connect
control; it never contains the pairing code or polling secret.

```sh
vp run --filter @glass/execution-node build
node apps/execution-node/dist/main.js pair \
  --api https://your-glass-cloud.example \
  --name "Build Mac"
```

After approval, register each workspace with a stable UUID and an absolute local path, then start
the outbound Glass Connect node. The node starts a loopback-only origin, obtains its proof-bound
tunnel configuration, and supervises the pinned connector; users never enter an execution URL:

```sh
export GLASS_EXECUTION_WORKSPACES='[{"id":"11111111-1111-4111-8111-111111111111","name":"Glass","root":"/absolute/path/to/Glass"}]'
node apps/execution-node/dist/main.js connect
```

The node stores its environment-held key and renewable credential in
`~/.glass/execution-node.json` with owner-only permissions. Override that location with
`--identity /absolute/path/to/identity.json` or `GLASS_NODE_IDENTITY_PATH`. See the
[execution-node runbook](docs/operations/execution-node.md) for verification and recovery.
