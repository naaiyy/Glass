# Development runtime

> **Audience:** Glass maintainers working on client surfaces, authentication, or execution.

Development is local by default. One repository command starts a local PostgreSQL database, applies
the committed migration chain, runs the Glass Cloud Worker in Wrangler's local runtime, and starts
the selected client surface. Staging and production remain deployed environments; ordinary product
development does not depend on either deployment.

## First-time setup

Create the local GitHub OAuth application and place its client ID and secret in the environment for
one setup command:

```sh
GLASS_LOCAL_GITHUB_CLIENT_ID=... GLASS_LOCAL_GITHUB_CLIENT_SECRET=... vp run dev:setup
```

The command generates independent Better Auth and Glass Connect secrets and writes
`apps/api/.dev.vars` with owner-only permissions. The file is ignored by Git. Its OAuth callback is
`http://127.0.0.1:5173/api/auth/callback/github` for the main checkout.

Docker must be running. `GLASS_DOCKER_CONTEXT` may select a non-default compatible engine. The
launcher automatically prefers Docker Desktop when the active context is Socktainer because
Socktainer does not implement the Compose lifecycle required by PostgreSQL. No Cloudflare or PlanetScale credential is required for the local product
database or Worker. Wrangler's authenticated developer session is used only by the selective remote
service binding that provisions managed Glass Connect tunnels.

## Surface entries

- `vp run dev` and `vp run dev:web` start the local database, Worker, and Vite browser application.
- `vp run dev:desktop` starts the same Vite renderer and loads it through Electron.
- `vp run dev:mobile` starts the local Worker and Metro. `dev:mobile:ios` also builds and opens iOS.
- `vp run dev:api` starts only the local database and Worker.
- `vp run glass-connect` publishes the current computer to the local Glass Cloud and registers this
  checkout as an execution workspace.
- `vp run dev:reset` removes the current checkout's local database volume and generated runtime
  state. It does not touch staging, production, or user files outside `.glass-local`.

The workspace-level client `dev` scripts delegate to the same orchestrator. Lower-level Vite,
Metro, and iOS scripts are implementation building blocks, not complete developer entries.

## Local topology

The main checkout uses stable ports: web `5173`, API `8787`, Metro `8081`, and PostgreSQL `55432`.
Worktrees receive a deterministic offset derived from their checkout name, so their databases,
ports, Wrangler persistence, and execution identities do not collide.

Vite proxies `/api`, `/v1`, and `/health` to the local Worker. Browser code therefore keeps the
same-origin product model used by deployed Glass Cloud. The Worker owns authentication,
authorization, durable product state, the environment registry, and execution metadata; the
execution node is never the product backend.

The local Worker uses local Durable Object persistence and local rate limits. PostgreSQL runs in
Docker and receives exactly the committed cloud migration chain. Glass Connect uses the real
staging tunnel-control Worker through an explicit remote service binding because tunnel and DNS
provisioning are Cloudflare provider capabilities. Execution data still flows directly through the
per-environment tunnel to the loopback-only execution node.

## Authentication

Local GitHub OAuth is a real Better Auth flow with a localhost callback. Vite marks only its API
proxy requests with the validated browser origin; the local Worker removes that internal header and
constructs the loopback request seen by Better Auth. Local sessions and users live only in the local
PostgreSQL database. Staging and production use separate OAuth applications, secrets, databases,
and callback URLs.

## Connection independence

The launcher always selects the local API unless `GLASS_CLOUD_ORIGIN` is explicitly provided. An
unrelated packaged or deployed identity cannot silently redirect development. Local execution state
lives in `~/.glass/local/<instance>/`, while the public `npx glass-connect@latest` command publishes
to production and keeps its state in `~/.glass/production/`.

A missing execution identity is a normal product-only state. After `vp run glass-connect` pairs the
machine, subsequent local launches resume the matching node automatically.

## Failure behavior

- Missing local auth configuration stops with a `vp run dev:setup` instruction.
- A database or Worker startup failure stops before a client opens.
- A required child process exiting unexpectedly stops the owned process tree.
- Closing the primary surface or pressing `Ctrl+C` terminates owned helpers.
- Execution availability remains separate from product availability; the launcher never invents an
  identity, credential, workspace, or product store.

## Native iOS lifecycle

The checked-in `apps/mobile/ios` host is authoritative native source. `AppDelegate` owns
process-wide Expo and React Native factory initialization, while `SceneDelegate` owns the
`UIWindow`, starts React Native for the connecting scene, forwards scene lifecycle events, and
preserves cold-start URL delivery.

## Source map

- Surface orchestrator: `scripts/dev-runner.mjs`
- Local database and Worker preparation: `scripts/local-runtime.mjs`,
  `scripts/local-database.mjs`, `infra/local/compose.yaml`
- Local secret setup and reset: `scripts/local-setup.mjs`, `scripts/local-reset.mjs`
- Browser proxy: `apps/web/vite.config.ts`
- Authentication boundary: `apps/api/src/auth.ts`, `apps/api/src/env.ts`
- Development publisher: `scripts/glass-connect.mjs`
- Desktop host and preload: `apps/desktop/src/`
- Mobile cloud configuration: `apps/mobile/src/cloud/`
- Execution identity and workspace registry: `apps/execution-node/src/`
