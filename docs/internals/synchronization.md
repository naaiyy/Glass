# Product synchronization and outbox

> **Audience:** Glass maintainers and contributors working on product synchronization and offline
> behavior.

Milestone 3 synchronizes cloud-owned product records over the product connection. The execution
connection is not involved. This protocol carries Glass-owned records and commands only. It never
carries OpenEditor document payloads, editor operations, runtime revisions, or future collaboration
state.

## Organization stream

Each organization has an independent monotonically increasing cursor. A mutation locks that
organization's sync-state row and allocates one distinct cursor per event, then commits canonical
writes, events, the final cursor, and its receipt atomically. Distinct event cursors prevent a pull
page from splitting one cursor group and silently skipping events. They do not make a cursor an
authorization token or couple product availability to execution.

Events contain a stable identifier, command identifier, actor, organization cursor, aggregate
identity and version, action, and either the validated current entity or a deletion tombstone.
Clients ignore duplicate cursors and stale aggregate versions. The server never trusts the
organization or actor encoded in a submitted command; both are checked against the authenticated
session and active membership.

## Snapshot, pull, and resnapshot

A new or invalidated client obtains an authoritative organization snapshot pinned to one captured
head. Snapshot pages use a typed continuation across members, projects, threads, messages, and
artifacts, carry at most 500 entities, and stay within the response byte bound. The client validates
every page, assembles and validates the organization projection, installs it as one recovery
boundary, then pulls events strictly after the pinned cursor. Pull responses contain at most 500
events, a next cursor, and `hasMore`; the client continues until caught up before considering the
projection live.

Reconnect starts with pull from the last durably applied cursor. If the cursor predates the
organization retention floor, the API returns a typed resnapshot requirement instead of silently
skipping changes. The client discards the stale projection only after a replacement snapshot has
been validated and durably installed.

Snapshot transport pages and events are bounded and contract-validated. Durable creation events
after the pinned cursor exclude their current rows regardless of database transaction timestamps,
and changes committed after that cursor are obtained by pull. Snapshot heads below the retained
event floor require a resnapshot. A transport page is never silently truncated: `hasMore` and the
next typed position describe the continuation. The current client projection is still assembled in
memory as a complete organization view, so pagination bounds network and server work rather than
claiming an unbounded local cache. Realtime delivery may later reduce latency, but it cannot replace
snapshot/pull recovery or widen authorization.

## Device-owned outbox

Web, desktop, and mobile persist a Glass product outbox through platform adapters. Each entry is scoped by the
authenticated user and organization and contains a stable command identifier, validated operation,
creation time, attempt metadata, and state. It is device state, not a cloud record and not an
alternative authority for product data.

The shared runtime follows this lifecycle:

- `queued`: durable on the device and eligible to send;
- `sending`: submitted in organization FIFO order; the HTTP contract accepts at most 100 commands;
- accepted commands are removed only after the server receipt names the committed organization
  cursor and the device durably removes its envelope;
- `needs-attention`: an unauthenticated, invalid, forbidden, not-found, protocol, or conflict result
  remains visible for explicit retry, replacement, or discard. An unauthenticated result also
  returns the client to its signed-out/session-required state; it is eligible again only after a
  fresh authenticated session is established.

Network failure or an ambiguous response returns an entry to `queued` and schedules the exact
command identifier and payload with bounded exponential backoff and jitter. An accepted entry is removed
only after the authoritative receipt is validated. If local removal fails, it remains queued and
the stable command identifier safely retrieves the same cloud receipt. A conflict is never
treated as resolved by replaying the same stale command. The user may discard that local intent or
replace it with a new command built from current cloud state; discarding never changes cloud state.

Sign-out stops delivery and isolates cached state, drafts, and outbox entries from the next user.
Product-offline UI may show pending local intent, but it must distinguish that intent from
cloud-confirmed records. Execution-offline state has no effect on outbox delivery.

OpenEditor content and editor operations never enter this outbox. The editor uses its explicit
load/save adapter today and adopts OpenEditor-owned synchronization when that capability is added
to the library.

## Source map

- Sync contracts and limits: `packages/contracts/src/sync.ts`
- Change contracts: `packages/contracts/src/events.ts`
- Shared sync runtime: `packages/client-runtime/src/`
- Cloud synchronization routes: `apps/api/src/index.ts`
- Durable product service: `apps/api/src/product-service.ts`
- Web and desktop device adapter: `apps/web/src/`
- Mobile device adapter: `apps/mobile/src/`
