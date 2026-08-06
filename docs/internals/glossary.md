# Glossary

> **Audience:** Everyone writing Glass code, contracts, documentation, or product copy.

- **artifact** — Durable cloud-owned product output associated with a project.
- **capability** — A typed execution operation an execution node advertises and is authorized to perform. Advertisement alone does not grant authority.
- **checkpoint** — Execution-environment-owned recoverable state for a workspace.
- **change log** — The ordered cloud-owned record used to synchronize canonical product changes. It is not the authority from which product tables are rebuilt.
- **device** — A web, desktop, or mobile client installation. It owns UI cache, unsynced drafts/outbox, and local shell/layout.
- **note** — A cloud-owned artifact associated with a project. Glass owns its identity, authorization, metadata, lifecycle, and durable OpenEditor storage adapter.
- **OpenEditor document** — The native versioned payload accepted and produced by OpenEditor. OpenEditor owns its schema, editing semantics, serialization, history, and future collaboration behavior. It is neither a Glass domain model nor a workspace file.
- **environment registry** — Cloud-owned records describing known execution environments and their state.
- **environment credential** — A short-lived, audience-scoped secret issued only after an execution environment proves possession of its current key. Glass Cloud stores its hash; connection authority also requires a fresh proof.
- **environment security event** — An append-only cloud audit record for an environment trust transition. It contains safe bounded metadata, never pairing codes, polling secrets, credentials, challenges, signatures, or keys.
- **execution connection** — The optional connection used for machine capabilities. Its loss does not take the product offline.
- **execution environment** — A capable computer or cloud runtime that owns workspaces, repositories, processes, provider credentials, local execution state, and checkpoints.
- **execution node** — The Node.js service running within an execution environment and presenting authorized capabilities.
- **execution session** — A bounded period of orchestrated work against an execution environment. It is not a Glass Cloud login session.
- **Glass Cloud** — The always-on product authority for identity, organizations, projects, artifacts, conversations, note storage, collaboration, synchronization, and durable product state.
- **Glass Connect** — The managed, authenticated path between Glass clients and published execution nodes. Glass Cloud supplies discovery, authorization, per-environment tunnel provisioning, and durable execution records. Execution traffic runs directly from a client through the environment's outbound Cloudflare Tunnel to its loopback-only node origin.
- **message** — One durable cloud-owned item in a thread.
- **mutation receipt** — A durable cloud-owned idempotency record for one accepted device command.
- **organization** — The cloud-owned membership and authorization boundary.
- **outbox** — Device-owned Glass product operations awaiting confirmation from Glass Cloud. It never carries OpenEditor content or editor operations, and entries are not cloud records until accepted.
- **pairing** — The proof-based trust operation that explicitly and revocably associates an execution environment key with an organization after administrator approval. It is not sign-in, network transport, or unlimited capability authorization.
- **publishing** — The user-facing action that requests, approves, and completes pairing for a capable execution environment, making it eligible for Glass Connect. Signing in alone does not publish a device.
- **product connection** — The primary, always-on client connection to Glass Cloud.
- **product synchronization** — Snapshot and ordered change delivery for Glass-owned records. It excludes OpenEditor document state and editor operations.
- **project** — A cloud-owned container for work, artifacts, threads, and notes. It is not a filesystem directory.
- **snapshot** — An authoritative bounded view of organization product state captured at a specific sync cursor.
- **sync cursor** — An organization-scoped monotonic position in the product change log.
- **tombstone** — A synchronized deletion marker for a Glass-owned record. It is not an OpenEditor content operation.
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
