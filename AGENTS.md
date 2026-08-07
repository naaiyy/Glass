# Glass

Glass is a multi-surface workspace for durable, collaborative agent work. The product remains available through Glass Cloud even when no execution environment is connected. A connected execution environment adds machine capabilities; it is never the source of truth for the product itself.

This repository is a clean-slate implementation. Previous Glass codebases may be inspected for context, but they are not authoritative: do not cite or copy them, and do not derive implementation or architecture decisions from them.

## Product non-negotiables

1. **The product is always available.** Identity, projects, artifacts, conversations, notes, and collaboration belong to Glass Cloud. A user can open Glass and work with cloud-owned state while every execution environment is offline.
2. **Execution is optional and explicit.** Filesystems, repositories, terminals, processes, local agent runtimes, Git, browser automation, and checkpoints belong to a connected computer or cloud execution environment. Losing that connection disables only capabilities that require it.
3. **Cloud and execution are independent connections.** Do not route product availability through an execution node, treat an execution session as authentication to Glass Cloud, or make either connection silently stand in for the other.
4. **Every boundary is authenticated, authorized, and typed.** Identity is never inferred from a hard-coded user, a client-supplied owner ID, a network location, or an execution process.
5. **Durable state is honestly durable.** Required cloud state is not replaced by process memory, local storage, sample data, or a production-path mock.
6. **All supported surfaces describe the same product.** Web, desktop, and mobile share contracts, domain language, and client runtime behavior. Desktop consumes the web renderer. Mobile is native and does not share DOM UI.
7. **Glass Connect is the initial execution path.** A signed-in user explicitly publishes an execution environment to an organization. The node exposes a loopback-only origin through a Glass-provisioned, remotely managed per-environment Cloudflare Tunnel and stage-scoped proxied DNS name. Clients connect directly to that tunnel after obtaining scoped authority from Glass Cloud. SSH launch, direct LAN endpoints, Tailscale-specific transport, user-managed tunnels, and manually entered execution URLs are not supported initial paths.

## A small glossary

Use these terms consistently in code, contracts, documentation, and product copy:

- **user**: a person authenticated with Glass Cloud.
- **organization**: the cloud-owned authorization and collaboration boundary.
- **project**: a cloud-owned container for work, artifacts, threads, notes, and execution associations. A project is not a filesystem directory.
- **artifact**: durable cloud-owned product output.
- **thread**: the durable cloud-owned conversation record.
- **message**: one durable item in a thread.
- **note**: a cloud-owned artifact whose content is an OpenEditor document. Glass owns the note's identity, authorization, project association, metadata, lifecycle, and durable storage adapter. OpenEditor owns its document model and editor behavior.
- **OpenEditor document**: the native versioned payload accepted and produced by OpenEditor. It is not a Glass domain model and is not a workspace file.
- **device**: a web, desktop, or mobile client installation and its local presentation state.
- **execution environment**: a capable computer or cloud runtime that owns workspaces and machine capabilities.
- **execution node**: the Node.js service running inside an execution environment and presenting those capabilities to Glass.
- **workspace**: an execution-environment-owned directory and its repository/filesystem context. It is not a project.
- **execution session**: a bounded period in which Glass orchestrates work against an execution environment.
- **capability**: an execution operation the node explicitly advertises and is authorized to perform.
- **checkpoint**: execution-environment-owned recoverable workspace state.
- **publishing**: the user-facing action that explicitly registers and pairs an execution environment with an organization and makes it eligible to connect through Glass Connect. Signing in alone does not publish a device.
- **Glass Connect**: the managed, authenticated path between Glass clients and a published execution environment. Glass Cloud controls discovery, trust, authorization, tunnel provisioning, and durable execution records; the execution data path runs directly from the client through the environment's outbound Cloudflare Tunnel to its loopback-only node origin.
- **product connection**: the always-on client connection to Glass Cloud.
- **execution connection**: the optional connection used for machine capabilities.

The canonical glossary is `docs/internals/glossary.md`.

## Data and runtime ownership

Ownership determines the authoritative writer and recovery source.

### Glass Cloud owns

- users and sessions
- organizations and authorization membership
- projects and artifacts
- threads and messages
- note artifact identity and metadata
- durable OpenEditor document payloads through the OpenEditor storage boundary
- uploads and media metadata
- notifications
- the environment registry and pairing records
- durable execution metadata and results

### The device owns

- UI cache
- unsynced drafts and the outbox
- local shell and layout preferences

Device state may improve latency or resilience. It is not an authority for cloud-owned records.
The Glass product outbox carries Glass product commands only. It must never become an editor-operation queue or a substitute for OpenEditor synchronization.

### The execution environment owns

- workspace files and repositories
- terminals and processes
- provider CLI credentials and processes
- local execution state
- workspace checkpoints

Glass Cloud may store durable metadata and results about execution. It does not become the owner of a workspace merely by recording them.

## The architectural mistakes that cause the most damage

1. **Making execution the product backend.** The API must not proxy ordinary product state through an execution node. An offline node cannot make projects, conversations, notes, or identity unavailable.
2. **Collapsing API and execution into one runtime.** `apps/api` must not spawn local processes, import `node-pty`, read user workspaces, use provider CLI credentials, or become dependent on `apps/execution-node` or `packages/execution-core`.
3. **Confusing a project with a workspace.** A project survives without an environment. A workspace is environment-local and may be absent, moved, or replaced.
4. **Treating connection as authorization.** A paired or connected node still needs scoped credentials, resource authorization, freshness checks, and proof of key possession. A WebSocket is transport, not trust.
5. **Inventing fallback identity or persistence.** Never ship fake authentication, hard-coded identity, silent anonymous mode, an in-memory substitute for required durable state, or a required-path placeholder.
6. **Duplicating the desktop renderer.** Desktop loads the shared web renderer and adds only the Electron host/preload boundary. A second desktop React application will drift.
7. **Leaking environment-specific types across boundaries.** Wire data belongs in `packages/contracts`; domain rules belong in `packages/domain`; execution orchestration belongs in `packages/execution-core`. Do not pass process handles, filesystem objects, or framework request objects across these boundaries.
8. **Reimplementing the editor in Glass.** OpenEditor is the sole document and editor implementation. Do not define a competing content schema, revision archive, undo/redo model, merge or conflict algorithm, collaboration protocol, presence model, editor change stream, or editor offline queue in Glass. Missing OpenEditor capabilities are implemented in OpenEditor and consumed through a dependency update; they are not replaced in a consumer application.

## Locked editor stack and boundary

OpenEditor is a stack decision, like React, Effect, Drizzle, and Better Auth. Use exact, coordinated OpenEditor versions because the packages are pre-1.0. The current integration target is `0.0.35`:

- shared document contract and validation: `@openeditor/core`
- web and desktop renderer: `@openeditor/react` and `@openeditor/ui`
- native mobile renderer: `@openeditor/native` with the Expo-compatible `react-native-webview`
- exporters or extensions only where a workspace imports their public APIs directly

Do not install or build against OpenEditor internal implementation packages. Do not use the superseded `@openeditor/react-native-prose-editor` line alongside the unified OpenEditor native surface.

Glass integrates OpenEditor; it does not wrap it in a second editor architecture:

- Glass owns note identity, organization/project authorization, discoverable metadata, lifecycle, and the authenticated durable storage and media adapters required by OpenEditor.
- Glass persists the native OpenEditor document payload after validating it with OpenEditor. It does not flatten that payload into generic artifact JSON, plain text, blocks, revisions, or Glass-specific document operations.
- OpenEditor owns the document schema, normalization, commands, transactions, rendering, serialization, selection, undo/redo, and cross-surface editor behavior.
- OpenEditor also owns future editor collaboration, CRDT/Yjs state, merging, presence, and editor synchronization semantics. These capabilities are added to OpenEditor itself and adopted by updating the dependency. There is no Glass-owned editor-collaboration milestone or fallback implementation.
- The Glass product change log, sync cursor, tombstones, and device outbox cover Glass-owned records and commands. OpenEditor document content and operations never travel through those generic mechanisms.
- Editor content uses an explicit OpenEditor load/save or future collaboration adapter. Glass may authenticate, authorize, store, and route that adapter, but it must not reinterpret the editor protocol.

## Hit every applicable surface

Before calling a product change complete, identify every applicable entry:

- **Clients.** Web, desktop, and mobile must make a deliberate decision. Desktop usually inherits web rendering but may need Electron permissions or IPC. Mobile uses native navigation and UI.
- **Product and execution connections.** Test product-only, execution-connected, reconnecting, and execution-offline states. Product-only is a normal state, not an error fallback.
- **Contracts.** Anything crossing a process, network, worker, or IPC boundary is represented in `packages/contracts` and validated at the boundary.
- **Editor.** A note change decides the OpenEditor web, desktop, and native surfaces deliberately. Import OpenEditor types rather than recreating them in `packages/contracts`, and keep OpenEditor payloads out of generic product sync.
- **Authority.** State which owner writes the data: cloud, device, or execution environment. Do not add a second implicit writer.
- **Authorization.** Check organization, project, environment, workspace, and capability scope as applicable. UI hiding is not authorization.
- **Reverse and failure paths.** Connect has disconnect; pairing has revoke; queued work has cancellation or a visible terminal state; loss of execution has an honest unavailable state.
- **Resilience.** Consider multiple devices, stale caches, duplicate delivery, reconnect, retry, and an environment disappearing during work.
- **Documentation.** User behavior belongs in `docs/user/`, architecture in `docs/internals/`, and operator procedures in `docs/operations/`. Add new canonical terms to the glossary.

## Authentication and authorization

- Glass Cloud authentication establishes a user session. Authorization is evaluated server-side for every protected resource and action.
- Signing in makes cloud-owned state and already-authorized environments discoverable. It does not silently publish the current device or turn it into an execution environment.
- Publishing is an explicit user action. On a capable computer it may be a single confirmation, but it creates a separate, revocable organization-to-environment trust relationship backed by an environment-held key.
- The API never trusts user IDs, organization IDs, roles, or ownership claims merely because a client sent them.
- Environment pairing creates a revocable relationship; it does not grant unlimited access to all projects or workspaces.
- Execution credentials are scoped, short-lived where possible, audience-bound, and stored only by the runtime that requires them.
- Glass Connect uses real user and environment authentication, scoped credentials, DPoP-style proof of possession, one-time short-lived WebSocket tickets carried as an opaque subprotocol value, and remotely managed per-environment Cloudflare Tunnels. The node consumes authority with fresh proof before accepting a WebSocket, signs its welcome with its Ed25519 environment key, validates each durable dispatch before machine side effects, and waits for the cloud-owned result acknowledgement before considering a result delivered.
- Tunnel reachability is not authority. The node origin is loopback-only, each public hostname is stage-scoped and proxied, and rotation or revocation invalidates stale authority and forces connector cleanup.
- Secrets, provider credentials, session tokens, pairing secrets, and proof keys must not enter logs, URLs, analytics payloads, fixtures, or source control.
- Desktop IPC uses an allowlisted preload API. Keep context isolation and renderer sandboxing enabled; do not expose raw Electron or Node APIs to the renderer.
- If credentials, signing keys, external services, or authority are missing, ask for them or report the block. Do not replace the required behavior with a fake integration, hard-coded identity, silent fallback, or local-only substitute.

Glass Cloud exposes only Better Auth-backed protected product endpoints; it never substitutes a fake login. See `docs/internals/environment-auth.md` for the separate execution-environment trust model.

## Development workflow

Glass is pnpm-managed and Vite Plus-operated. Use the repository-pinned toolchain.

- `vp i` installs workspace dependencies from the lockfile.
- `vp run dev` starts configured development tasks.
- `vp check` runs configured formatting and lint gates.
- `vpr typecheck` runs workspace typechecks.
- `vp run test` runs workspace tests.
- `vp run build` runs the configured full build.

Use focused workspace commands during iteration, for example `vp run --filter @glass/web typecheck` or `vp run --filter @glass/contracts test`. Read package scripts before choosing a focused command. Do not introduce Turborepo or document generic `pnpm build`, `pnpm test`, or `pnpm lint` as the canonical workflow.

Use `~6.0.3` TypeScript and tsgo where the configured Node/web workspace supports it. Mobile may use `tsc` where the Expo toolchain requires it.

## Verification

During normal iteration, run the smallest proof that covers the change, then expand to affected dependents. Tests should enforce boundaries and observable behavior rather than merely snapshotting placeholders.

This repository-foundation task explicitly requires the full repository gates:

```text
vp i
vp check
vpr typecheck
vp run test
vp run build
```

It also requires the configured desktop build and preload/output smoke check. A change is not complete because one application starts; all five runnable applications and six packages must participate correctly in the workspace.

## Documentation ownership

- `docs/README.md` is the documentation index and states the implementation boundary.
- `docs/internals/` is for maintainers and contributors. Internal pages include an audience note and exact source maps when code exists.
- `docs/operations/` is for operators and release owners. Do not claim infrastructure, deployment, signing, or stores are operational before configuration and credentials exist.
- `docs/user/` is shipped-product language. Do not expose repository tooling there. Clearly label behavior that is not available yet.
- Root `AGENTS.md` owns repository-wide engineering and product invariants. A nested `AGENTS.md` may add local rules but cannot weaken these boundaries without explicit maintainer approval.

Write present-tense descriptions of the current system. Avoid migration, rewrite, legacy, or historical narrative. Distinguish implemented foundation from future behavior directly.

## Repository map

- `apps/web` — Vite and React 19 product renderer.
- `apps/desktop` — Electron host and minimal preload boundary; loads the web renderer.
- `apps/mobile` — Expo 57 React Native client with React Navigation and no Expo Router.
- `apps/api` — Cloudflare Worker product authority boundary. No machine execution capabilities.
- `apps/execution-node` — Node/Effect runtime for execution-environment capabilities.
- `packages/contracts` — boundary schemas and wire contracts; no heavy orchestration.
- `packages/domain` — pure product domain types, rules, and typed errors.
- `packages/client-runtime` — client connection/state behavior shared by web and mobile.
- `packages/shared` — narrow cross-runtime utilities through explicit subpath exports.
- `packages/ui-web` — reusable DOM UI for web and the desktop renderer; never imported by mobile.
- `packages/execution-core` — shared execution domain and orchestration; not a server.
- `infra/cloud` — declarative cloud infrastructure and environment configuration.
- `docs/internals` — architecture and contributor documentation.
- `docs/operations` — operational and release runbooks.
- `docs/user` — user-facing documentation.

## Performance and implementation taste

- Prefer the smallest explicit model that preserves the ownership boundary.
- Keep orchestration pure where possible and concentrate platform complexity in adapters.
- Validate once at ingress, use typed values internally, and return typed errors at boundaries.
- Prefer inferred types; do not use `any` to escape a contract.
- Use explicit package subpath exports. Avoid indiscriminate barrel files and dependency cycles.
- Keep initial bundles small, lazy-load noncritical surfaces, virtualize long lists, and avoid continuously repainting animations.
- Bound connection buffers, retries, queues, log volume, and retained event history. Reconnect loops use backoff and jitter.
- Do not send full transcripts, directory trees, or repository state when a delta or page is sufficient. OpenEditor document transfer follows the explicit OpenEditor persistence or collaboration boundary rather than the generic product change log.
- Measure before adding caches. Every cache needs an owner, invalidation rule, and safe stale-state behavior.
- Comments explain invariants and why a boundary exists. Names and types explain ordinary control flow.

## Completion rules

A required milestone path is complete only when it is implemented, wired into every applicable workspace and surface, and verified. Completion never includes:

- fake authentication or hard-coded identity
- silent fallback that changes authority or behavior
- a production-path mock
- an in-memory substitute for required durable state
- a placeholder on a required path
- a TODO that stands in for required behavior
- a claim that a later milestone is already operational

If required credentials or external authority are unavailable, stop at the real boundary, keep the implementation honest, and ask for what is missing. Do not simulate success.
