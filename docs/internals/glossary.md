# Glossary

> **Audience:** Everyone writing Glass code, contracts, documentation, or product copy.

- **artifact** — Durable cloud-owned product output associated with a project.
- **capability** — A typed execution operation an execution node advertises and is authorized to perform. Advertisement alone does not grant authority.
- **checkpoint** — Execution-environment-owned recoverable state for a workspace.
- **device** — A web, desktop, or mobile client installation. It owns UI cache, unsynced drafts/outbox, and local shell/layout.
- **document** — A cloud-owned collaborative document. It is not a workspace file.
- **environment registry** — Cloud-owned records describing known execution environments and their state.
- **execution connection** — The optional connection used for machine capabilities. Its loss does not take the product offline.
- **execution environment** — A capable computer or cloud runtime that owns workspaces, repositories, processes, provider credentials, local execution state, and checkpoints.
- **execution node** — The Node.js service running within an execution environment and presenting authorized capabilities.
- **execution session** — A bounded period of orchestrated work against an execution environment. It is not a Glass Cloud login session.
- **Glass Cloud** — The always-on product authority for identity, organizations, projects, artifacts, conversations, documents, collaboration, synchronization, and durable product state.
- **Glass Connect** — The future managed, authenticated transport to execution nodes. It does not own product state and is not implemented in the foundation.
- **message** — One durable cloud-owned item in a thread.
- **organization** — The cloud-owned membership and authorization boundary.
- **outbox** — Device-owned operations awaiting confirmation from Glass Cloud. Outbox entries are not cloud records until accepted.
- **pairing** — Explicit, revocable authorization to associate an execution environment with Glass. Pairing is not unlimited capability authorization.
- **product connection** — The primary, always-on client connection to Glass Cloud.
- **project** — A cloud-owned container for work, artifacts, threads, and documents. It is not a filesystem directory.
- **provider** — A local agent runtime or CLI operated by an execution environment.
- **thread** — The durable cloud-owned conversation record for messages and work history.
- **user** — A person authenticated with Glass Cloud.
- **workspace** — An execution-environment-owned directory and repository/filesystem context. A project may exist without one.

## Naming rules

Use `project` for the product record and `workspace` for the environment-local filesystem context. Use `session` with a qualifier: `user session` or `execution session`. Use `node` only for the execution service, not for a device or environment record. Use `offline` with the affected connection: product offline and execution offline are different states.

## Source map

- Wire vocabulary: `packages/contracts/src/`
- Domain vocabulary: `packages/domain/src/`
- Client connection vocabulary: `packages/client-runtime/src/`
- Execution vocabulary: `packages/execution-core/src/`
