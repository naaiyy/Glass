# OpenEditor integration

> **Audience:** Glass maintainers implementing or reviewing notes and editor behavior.

OpenEditor is Glass's sole document and editor implementation. It is a locked stack decision, not
an example or an interchangeable rendering component. Glass must not reproduce OpenEditor
semantics in product contracts, database tables, client synchronization, or application UI.

## Ownership boundary

Glass owns the product shell around a note:

- note artifact identity and its organization and project association;
- authenticated authorization and lifecycle;
- discoverable title, icon, and other explicitly defined product metadata;
- the durable storage, media, and transport adapters requested by OpenEditor; and
- delivery of the native OpenEditor payload without translating it into a Glass document model.

OpenEditor owns:

- the versioned document schema and validation;
- normalization, commands, transactions, selection, and editing behavior;
- web, desktop-renderer, and native rendering behavior;
- serialization, import/export, and editor undo/redo history; and
- future CRDT/Yjs state, merging, presence, collaboration, and editor synchronization.

If an editor capability is absent, it is implemented in OpenEditor and consumed by upgrading the
dependency. Glass does not provide a temporary editor schema, revision system, conflict algorithm,
collaboration service, or editor outbox. There is no separate Glass-owned editor-collaboration
milestone.

## Stack decision

The coordinated integration target is OpenEditor `0.0.34`, pinned exactly because the packages are
pre-1.0:

- `@openeditor/core` for the portable document contract and validation;
- `@openeditor/react` and `@openeditor/ui` for web and the desktop renderer;
- `@openeditor/native` for mobile; and
- the Expo-compatible `react-native-webview` required by the native surface.

Workspaces add exporters or extensions only when they directly consume those public APIs. Glass
does not import OpenEditor internal embedded-runtime packages and does not combine the unified
native surface with the superseded `@openeditor/react-native-prose-editor` package.

OpenEditor versions advance together. An upgrade includes contract validation, web/desktop tests,
native tests, persisted-payload compatibility verification, and a deliberate review of new adapter
requirements.

## Persistence and synchronization

Glass persists the complete native OpenEditor payload through a dedicated, authenticated note
content boundary. The payload is validated with OpenEditor and stored without flattening it into
plain text, generic artifact JSON, Glass blocks, revisions, or product events.

The current adapter accepts one complete, normalized OpenEditor document up to 5 MiB. Glass records
the save time and authenticated saving user on the server; clients cannot supply either value.
Concurrent complete-document saves are last-writer-wins. Web and native clients debounce ordinary
saves and flush before leaving the editor when possible. A failed save remains visible and requires
an explicit retry; there is no durable Glass editor outbox.

Glass product synchronization carries note artifact identity and metadata only. Its organization
cursor, snapshots, tombstones, and device outbox never carry OpenEditor content or editor
operations. OpenEditor content is loaded and saved through its explicit adapter; future
collaboration follows the OpenEditor protocol and may use Glass only for authentication,
authorization, durable storage, and transport routing.

An OpenEditor runtime revision is an in-session bridge value. It is not a durable Glass version,
sync cursor, revision archive, or collaboration protocol.

## Source map

- Repository invariants: `AGENTS.md`
- Product ownership: `docs/internals/product-cloud.md`
- Product synchronization exclusion: `docs/internals/synchronization.md`
- Canonical vocabulary: `docs/internals/glossary.md`
- Note wire contract: `packages/contracts/src/notes.ts`
- Durable note tables: `apps/api/src/db/schema.ts`
- Note authorization and persistence: `apps/api/src/product-service.ts`
- Note HTTP routes: `apps/api/src/index.ts`
- Web editor integration: `apps/web/src/product-cloud/NoteEditor.tsx`
- Native editor integration: `apps/mobile/src/App.tsx`
- Coordinated dependency versions: `pnpm-workspace.yaml`, `apps/api/package.json`,
  `apps/web/package.json`, `apps/mobile/package.json`, `packages/contracts/package.json`
