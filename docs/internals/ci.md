# Continuous integration

> **Audience:** Glass maintainers and contributors changing workspace configuration or verification.

CI follows the repository’s Vite Plus workflow on portable GitHub-hosted runners.

## Canonical gates

The foundation is verified with:

```text
vp i
vp check
vpr typecheck
vp run test
vp run build
```

`voidzero-dev/setup-vp@v1` installs and caches the repository-pinned Vite Plus toolchain and dependencies. CI then runs configured formatting/lint checks, workspace typechecks, tests, and builds. The desktop pipeline additionally verifies its Electron outputs and preload artifact.

Do not replace these commands in documentation or workflows with generic `pnpm build`, `pnpm test`, or `pnpm lint`. pnpm manages the workspace and lockfile; Vite Plus operates the developer and CI workflow.

## Iteration

During development, use the narrowest applicable workspace command and test affected dependents. Examples include:

```text
vp run --filter @glass/web typecheck
vp run --filter @glass/contracts test
vp run --filter @glass/desktop build
```

Check the target package scripts before selecting a task. Mobile may use `tsc` internally where Expo compatibility requires it; Node/web packages use tsgo where configured.

## Required invariants

Automated checks enforce, at minimum:

- `apps/api` does not depend on execution-only packages or process/PTY dependencies.
- mobile does not depend on Expo Router or DOM-only UI.
- desktop consumes the shared web renderer and produces its main/preload outputs.
- all five runnable applications and all six packages participate in workspace verification.
- package entry points are explicit and boundary contracts typecheck.

Signing, deployment, app-store publication, and cloud credentials are not part of foundation CI. Workflows must not claim those external systems are configured.

## Source map

- CI workflows: `.github/workflows/`
- Root Vite Plus tasks: `package.json`
- Vite Plus checks and ignores: `vite.config.ts`
- Workspace packages and catalog: `pnpm-workspace.yaml`
- Reproducible dependency graph: `pnpm-lock.yaml`
- Desktop smoke verifier: `apps/desktop/scripts/smoke-test.mjs`
