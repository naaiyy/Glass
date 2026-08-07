# Execution environments

> **Audience:** Glass maintainers and contributors working on machine capabilities.

An execution environment is a computer or cloud runtime that can host workspaces and agent tooling. It is optional. An execution node runs inside the environment and presents an explicit set of capabilities to Glass.

An environment is not the same thing as a device or user session. A phone or browser installation is a device even when it only consumes capabilities from another computer. A desktop can be both a device and an execution environment, but signing into its client establishes only the device's user session. The user must separately publish the computer before its execution node may connect.

## Ownership

The execution environment owns:

- workspace files and repositories
- terminals and processes
- provider CLI credentials and processes
- local execution state
- workspace checkpoints

Glass Cloud stores the environment registry, pairing records, and durable execution metadata/results. A device stores only its presentation cache, drafts/outbox, and local shell/layout.

## Capability model

A node advertises supported capability identifiers and protocol compatibility. Advertisement is
descriptive, not authorization. A published environment is eligible for every supported operation
type, but every request still requires an authenticated node, organization membership, a valid
project/environment/workspace association, and contract validation.

Environment identity and publishing are implemented independently of machine capabilities.
Filesystem access, terminal/process management, Git, checkpoints, streaming, cancellation, and
remote dispatch run behind typed operation contracts. Web, desktop, and native mobile expose these
capabilities only for an authorized project/workspace binding and online environment.

## Process boundary

`apps/execution-node` is the only application runtime intended to touch machine capabilities. `packages/execution-core` contains reusable execution domain and orchestration logic but does not listen on a port, establish tunnels, or spawn a process by itself.

Execution-only dependencies do not enter `apps/api`, web, mobile, or shared product-domain packages.

## Publishing and access

Publishing is the user-facing enrollment flow for a capable computer or cloud runtime. It combines explicit organization approval with environment registration and pairing, then makes the node eligible for managed Glass Connect connectivity. Pairing establishes trust; Glass Connect supplies reachability; capability grants authorize particular work.

One Glass Connect launcher owns the lifecycle. With no durable identity it creates an Ed25519 key
pair, requests a short-lived pairing code, and polls with a separate high-entropy secret. A
signed-in organization owner or administrator approves the code by entering it once. The launcher
then completes proof, starts the connector, and remains online. With an existing valid identity the
same launcher resumes directly; a stale or revoked identity starts a fresh publication ceremony.

There are no project or machine-permission choices: publication makes the environment eligible for
all organization projects and all supported execution capabilities. Pairing codes, polling
secrets, private keys, signatures, challenges, and issued credential tokens are not stored in
security audit metadata. Active unauthenticated requests are bounded per public key and per
environment.

An environment published to an organization can be discovered by other signed-in devices only when
their user is authorized through that organization. `workspace_bindings` explicitly maps one
project to one advertised environment-owned directory. Operation creation and dispatch require
that binding even though the environment is eligible for every project. Environment presence does
not weaken server-side authorization.

After publication, the same process starts a loopback-only origin and requests its per-environment managed
tunnel using a current credential and fresh key proof. The public hostname is discovered from Glass
Cloud; clients do not enter it. Signing in on another device makes the published environment
discoverable but does not publish or pair that second device.

## Source map

- Node runtime: `apps/execution-node/src/`
- Execution contracts: `packages/contracts/src/`
- Execution domain/orchestration: `packages/execution-core/src/`
- Environment identity and credential contracts: `packages/contracts/src/environments.ts`
- Product-side environment service: `apps/api/src/environment-service.ts`
- Durable environment schema and audit records: `apps/api/src/db/schema.ts`
- Publishing routes: `apps/api/src/index.ts`
- Node-held identity and pairing client: `apps/execution-node/src/identity.ts`
- Web approval and environment management: `apps/web/src/product-cloud/EnvironmentSettings.tsx`, `apps/web/src/product-cloud/EnvironmentDirectory.tsx`
- Native mobile environment management: `apps/mobile/src/screens/EnvironmentsScreen.tsx`
- Managed tunnel lifecycle: `apps/api/src/tunnel-service.ts`, `infra/cloud/alchemy.run.ts`
- Loopback node origin and connector: `apps/execution-node/src/tunnel-origin.ts`, `apps/execution-node/src/cloudflared.ts`
