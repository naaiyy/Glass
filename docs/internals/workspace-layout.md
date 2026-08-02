# Workspace layout

> **Audience:** Glass maintainers and contributors navigating the monorepo.

Glass is a pnpm workspace operated through Vite Plus. It does not use Turborepo.

## Applications

- `apps/web` — Vite + React 19 renderer for the browser and desktop host.
- `apps/desktop` — Electron main/preload host. It consumes the web renderer instead of maintaining another React renderer.
- `apps/mobile` — Expo 57 native application using React Navigation, explicitly without Expo Router.
- `apps/api` — Cloudflare Worker product boundary. It has no local process or user-workspace access.
- `apps/execution-node` — Node/Effect execution-environment runtime.

## Packages

- `packages/contracts` — schemas and typed data crossing runtime boundaries.
- `packages/domain` — pure product domain types, invariants, and errors.
- `packages/client-runtime` — client connection and synchronization behavior shared across web and mobile.
- `packages/shared` — narrow cross-runtime helpers through explicit subpath exports.
- `packages/ui-web` — DOM UI used by web and the desktop renderer; mobile never imports it.
- `packages/execution-core` — execution domain and orchestration logic; not a server.

Packages expose deliberate entry points. Do not introduce a root barrel that exports unrelated modules, framework-specific values, or execution-only dependencies.

## Infrastructure and documentation

- `infra/cloud` — declarative cloud infrastructure and environment configuration.
- `docs/internals` — contributor architecture.
- `docs/operations` — operational contracts and runbooks.
- `docs/user` — shipped user behavior.
- `.github/workflows` — portable GitHub-hosted CI.

## Toolchain

The repository pins Node `^24.13.1`, pnpm `11.10.0`, TypeScript `~6.0.3`, `@typescript/native-preview` `7.0.0-dev.20260604.1`, `effect`/`@effect/platform-node`/`@effect/vitest` `4.0.0-beta.102`, `@effect/tsgo` `0.13.2`, and Vite Plus `0.2.2` through the alias `npm:@voidzero-dev/vite-plus-core@0.2.2`. Workspace catalogs centralize shared versions. Vite Plus is the command surface even though pnpm owns the workspace and lockfile.

## Source map

- Workspace membership and policy: `pnpm-workspace.yaml`
- Root scripts and tool versions: `package.json`
- Vite Plus configuration: `vite.config.ts`
- TypeScript base configuration: `tsconfig.base.json`
- Continuous integration: `.github/workflows/`
