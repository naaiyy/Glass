# Glass

Glass is an always-available cloud product with optional connections to execution environments. This clean-slate repository currently implements the architectural constitution and runnable monorepo foundation: five applications, six boundary-focused packages, Vite Plus workflow policy, portable CI, and documentation.

Durable product features, authentication, cloud infrastructure, machine execution capabilities, Glass Connect, collaboration, and releases are intentionally outside this foundation milestone.

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
