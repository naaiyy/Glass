# Glass

Glass is an always-available cloud product with optional connections to execution environments.
This repository implements the architectural constitution, runnable monorepo, deployed Glass Cloud,
durable product core, environment identity, Glass Connect, and execution capabilities across five
applications and six boundary-focused packages.

Milestone 3 adds organization-scoped durable product records, typed synchronization, and a
device-owned offline outbox without making execution a product dependency. The shared web renderer,
Better Auth entry, and durable product API run locally during development and are deployed together
in staging and production. Production has passed live authentication verification. Environment publishing uses
durable organization-owned records, environment-held Ed25519 keys, explicit administrator
approval, proof-bound short-lived credentials, revocation, and security audit events.
Environment publishing, proof-bound credentials, managed per-environment Cloudflare Tunnels,
stage-scoped proxied DNS, a loopback node origin, direct client WebSockets, revocation, and durable
dispatch/results are deployed in staging and production. The production path has
passed live publishing, managed-tunnel, direct WebSocket, durable-result, and cleanup
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

Run `vp run dev:setup` once with the localhost GitHub OAuth client ID and secret. `vp run dev` then
starts an isolated Docker PostgreSQL database, applies the committed migration chain, runs the Glass
Cloud Worker locally, starts Vite with HMR and a same-origin product proxy, and opens the browser.
No separate server terminal or frontend deployment is required.

Use `vp run dev:web` for the same explicit web entry, `vp run dev:desktop` for the shared live
renderer in Electron, and `vp run dev:mobile` or `vp run dev:mobile:ios` for Expo. Every client
entry uses the same local Worker and database and resumes its matching execution node when
configured. The focused `dev:api` and `dev:execution-node` tasks are service-level diagnostics, not
prerequisites for a client launch. `vp run glass-connect` publishes the current checkout to this
local runtime; the public `npx glass-connect@latest` command publishes to production.

Use the repository workflow for verification:

```sh
vp check
vpr typecheck
vp run test
vp run build
```

## Publish an execution environment

Run Glass Connect from the folder you want to use, then approve the printed code in **Settings →
Environments** while signed in to the same Glass organization. The same process publishes the
computer, shares the current folder, and remains connected.

```sh
npx glass-connect@latest
```

Open a project and choose the folder from its **Execution** card. The node starts a loopback-only
origin, obtains its proof-bound tunnel configuration, and
supervises the pinned connector; users never enter an execution URL. `GLASS_EXECUTION_WORKSPACES`
remains an explicit process-local override for automation.

The node stores its environment-held key and renewable credential in its private Glass state
directory with owner-only permissions. See the
[execution-node runbook](docs/operations/execution-node.md) for verification and recovery.
