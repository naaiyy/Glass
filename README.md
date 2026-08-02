# Glass

Glass is an always-available cloud product with optional connections to execution environments.
This clean-slate repository implements the architectural constitution, runnable monorepo, deployed
Glass Cloud foundation, and the deployed Milestone 3 durable product core
across five applications and six boundary-focused packages.

Milestone 3 adds organization-scoped durable product records, typed synchronization, and a
device-owned offline outbox without making execution a product dependency. The shared web renderer,
Better Auth entry, and durable product API are deployed together in development, staging, and
production and have passed live authentication verification. Environment pairing, Glass Connect,
machine execution capabilities, production-ready multi-user product experiences, and releases
remain later milestones. Editor collaboration is not one of those Glass milestones: OpenEditor
owns it, and Glass adopts it through a coordinated OpenEditor dependency update.

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
