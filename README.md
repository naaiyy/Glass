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

Install the global `vp` command from the [Vite Plus guide](https://viteplus.dev/guide/), install
dependencies once, then launch the usable development application:

```sh
vp i
vp run dev
```

`vp run dev` launches the complete browser application: it verifies the development Glass Cloud
API and authentication boundary, starts the local Vite renderer with HMR and a same-origin product
proxy, opens the browser, and resumes the execution node when its published identity and workspace
registry exist. No separate server terminal or frontend deployment is required.

Use `vp run dev:web` for the same explicit web entry, `vp run dev:desktop` for the shared live
renderer in Electron, and `vp run dev:mobile` or `vp run dev:mobile:ios` for Expo. Every client
entry selects the checked-in development Glass Cloud origin, supplies its client runtime
configuration, and resumes the same execution node when configured. `GLASS_CLOUD_ORIGIN` and the
identity/workspace path variables remain explicit operator overrides. The focused `dev:api` and
`dev:execution-node` tasks are service-level diagnostics, not prerequisites for a client launch.

Use the repository workflow for verification:

```sh
vp check
vpr typecheck
vp run test
vp run build
```

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

After approval, register each workspace once with a stable UUID and an absolute local path. The
environment-owned registry defaults to `~/.glass/execution-workspaces.json`:

```sh
node apps/execution-node/dist/main.js workspace-add \
  --id 11111111-1111-4111-8111-111111111111 \
  --name "Glass" \
  --root /absolute/path/to/Glass
node apps/execution-node/dist/main.js connect
```

The node starts a loopback-only origin, obtains its proof-bound tunnel configuration, and
supervises the pinned connector; users never enter an execution URL. `GLASS_EXECUTION_WORKSPACES`
remains an explicit process-local override for automation.

The node stores its environment-held key and renewable credential in
`~/.glass/execution-node.json` with owner-only permissions. Override that location with
`--identity /absolute/path/to/identity.json` or `GLASS_NODE_IDENTITY_PATH`. See the
[execution-node runbook](docs/operations/execution-node.md) for verification and recovery.
