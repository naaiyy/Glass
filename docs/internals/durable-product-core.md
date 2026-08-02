# Durable product core

> **Audience:** Glass maintainers and contributors working on Milestone 3 product state.

Glass Cloud is the sole authority for organizations, projects, threads, messages, and artifacts.
These records remain available without an execution environment. Notes use the separate
OpenEditor boundary described in [OpenEditor integration](openeditor.md); Glass does not define a
general document entity.

## Canonical model

PlanetScale Postgres stores the canonical current state:

- `organizations` and `organization_members` define the tenancy and authorization boundary.
- `projects` contain Milestone 3 threads and artifacts. A project is never a
  workspace or filesystem directory.
- `threads` contain immutable, ordinally ordered `messages`. Message bodies are never edited in
  place.
- `artifacts` hold bounded, contract-validated Glass-owned `agent-output` records and note
  identity/metadata. The artifact body is not an escape hatch for OpenEditor payloads, arbitrary
  application state, binary uploads, or object storage.
- `note_contents` stores the validated native OpenEditor payload behind the dedicated authenticated
  note adapter. It is not a revision archive or product change-log projection.

Mutable records carry a version used for optimistic concurrency. Organization-scoped composite
foreign keys prevent a project child from referring to another organization. Project, thread, and
artifact removal is an archive operation: the canonical row remains, and sync emits a tombstone.
Physical retention and purge are separate operational policies and must not make an offline client
miss a deletion.

Note identity and metadata use explicit note operations in the product mutation union. Native
OpenEditor content uses the separate editor integration rather than widening the artifact body or
product event payload. Glass persists the library's payload; it never creates document revisions,
blocks, merge rules, or editor events. The current adapter saves complete validated snapshots with
server-owned save metadata. Concurrent saves are last-writer-wins until OpenEditor supplies its
collaboration protocol; Glass does not invent content CAS or merging in the interim.

## Authorization

The API derives the user from the Better Auth session. A protected operation requires an active
membership row for that user and organization; a client-supplied user, role, or ownership claim is
never authority. The API verifies the organization on every referenced project and child record.
Role checks are server-side, including owner-only membership changes and protection against
removing the final active owner.

Organization creation is the bootstrap exception: it atomically creates the organization, its sync
state, and an owner membership for the authenticated creator. There is no anonymous, hard-coded,
or in-memory fallback.

## Mutation transaction

Each accepted command executes in one database transaction:

1. authenticate the session and authorize active organization membership;
2. lock the organization sync-state row and check the command receipt;
3. validate expected versions and every cross-record organization relationship;
4. write the canonical row or archive marker;
5. allocate one strictly increasing organization cursor for each typed change-log event;
6. persist the idempotent mutation receipt and result;
7. commit the canonical projection, events, cursor, and receipt together.

A repeated command with the same authenticated user, organization, identifier, and request hash
returns its recorded result. Reusing the identifier with different content is rejected. Rejected
commands do not advance the cursor or partially change canonical state.

Push batches are all-or-nothing. Commands are evaluated in request order inside one serializable
transaction so dependent offline creates can commit together. The first rejected command aborts
the entire batch; clients retain every command from that batch and resolve or retry from the
authoritative state. A successful response contains accepted receipts only. Typed rejection is the
HTTP failure for the atomic batch rather than a mixture of accepted and rejected command results.

The change log is a synchronization and audit boundary, not the source of truth. Canonical tables
are not rebuilt by replaying product events, and event acceptance never substitutes for the
canonical write.

## Bounds and failure behavior

Contracts bound names, text, agent-output JSON depth and size, command batches, and pull batches
before durable work begins. Clients do not request unbounded transcripts. A version mismatch is a
typed conflict, not last-write-wins. Missing membership is forbidden, unknown scoped records are
not exposed across tenants, and unavailable durable storage returns an honest product-unavailable
error.

Organization snapshot transport is cursor-pinned and paginated across a typed entity order. Each
page has entity-count and serialized-byte limits, and the client validates the complete assembled
projection before installing it. Pagination bounds transport and server work; the current device
projection remains a complete in-memory organization view.

## Source map

- Durable schema: `apps/api/src/db/schema.ts`
- Product service: `apps/api/src/product-service.ts`
- Product routes: `apps/api/src/index.ts`
- Product and event contracts: `packages/contracts/src/product.ts`,
  `packages/contracts/src/events.ts`
- Domain rules: `packages/domain/src/`
- Committed migrations: `infra/cloud/migrations/postgres/`
