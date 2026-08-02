# Releases

This page is for Glass release owners.

## Current status

The repository builds and verifies applications but does not publish a complete production product
release. Milestone 2 cloud infrastructure, database migrations, authentication, and Worker
deployment are operational under the separate cloud workflow. Milestone 3 deployment is not
claimed until its migrations, routes, and client flows pass live verification. Desktop
signing/notarization, mobile store credentials, product web publication, update channels, and
release rollback automation remain unconfigured unless their real credentials and workflows exist.

## Release contract

A release candidate starts from a reproducible lockfile and passes:

```text
vp i
vp check
vpr typecheck
vp run test
vp run build
```

The desktop candidate also passes its Electron output and preload smoke check. Release owners verify that all five runnable applications and six packages participate, versioning is coherent, documentation describes shipped behavior, and no future-milestone page claims readiness.

Before production publication, the relevant surface also requires:

- authenticated deployment authority and least-privilege credentials
- environment-specific configuration validation
- database migration and rollback review where applicable
- desktop signing and notarization
- iOS and Android signing, store metadata, and review readiness
- API, infrastructure, and web deployment health checks
- compatibility checks for product and execution protocol versions
- an explicit rollback or rollout-stop procedure
- release notes that distinguish available features from planned architecture

Never bypass a missing credential by disabling verification, embedding a test identity, publishing unsigned artifacts as production, or marking an unavailable integration successful.

## Source map

- CI and build workflows: `.github/workflows/`
- Application manifests: `apps/*/package.json`
- Root toolchain and scripts: `package.json`
- Dependency lock: `pnpm-lock.yaml`
- Cloud infrastructure declarations: `infra/cloud/`
