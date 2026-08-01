# Execution environments

> **Audience:** Glass maintainers and contributors working on machine capabilities.

An execution environment is a computer or cloud runtime that can host workspaces and agent tooling. It is optional. An execution node runs inside the environment and presents an explicit set of capabilities to Glass.

## Ownership

The execution environment owns:

- workspace files and repositories
- terminals and processes
- provider CLI credentials and processes
- local execution state
- workspace checkpoints

Glass Cloud stores the environment registry, pairing records, and durable execution metadata/results. A device stores only its presentation cache, drafts/outbox, and local shell/layout.

## Capability model

A node advertises supported capability identifiers and protocol compatibility. Advertisement is descriptive, not authorization. Every requested operation also requires an authenticated node, a scoped grant, a permitted project/environment/workspace association, and contract validation.

The foundation descriptor proves the runtime and contract boundary only. Filesystem access, terminal/process management, provider runtimes, Git, browser automation, checkpoints, and remote transport are not implemented.

## Process boundary

`apps/execution-node` is the only application runtime intended to touch machine capabilities. `packages/execution-core` contains reusable execution domain and orchestration logic but does not listen on a port, establish tunnels, or spawn a process by itself.

Execution-only dependencies do not enter `apps/api`, web, mobile, or shared product-domain packages.

## Source map

- Node runtime: `apps/execution-node/src/`
- Execution contracts: `packages/contracts/src/`
- Execution domain/orchestration: `packages/execution-core/src/`
- Product-side environment records, when implemented: `apps/api/src/`
