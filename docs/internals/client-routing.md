# Client routing

> **Audience:** Glass maintainers and contributors.

Glass uses platform-native navigation primitives while keeping route intent consistent across
surfaces.

## Web and desktop

The shared web renderer uses TanStack Router with file-based route definitions in
`apps/web/src/routes/`. Web uses browser history. Electron loads the same renderer and uses hash
history because the packaged renderer is file-backed. The desktop host does not own a second UI or
router; it only supplies the Electron preload boundary and authenticated product-request bridge.

The current web routes are:

- `/auth` — Better Auth-backed GitHub sign-in surface.
- `/organizations` — authenticated organization directory and creation surface.
- `/workspace` — the selected organization’s product and execution workspace.
- `/workspace/projects/:projectId` — a project in the selected organization.
- `/workspace/threads/:threadId` — a thread in the selected organization.
- `/workspace/artifacts/:artifactId` — an artifact in the selected organization.
- `/workspace/notes/:noteId` — a note editor in the selected organization.

The root route owns one persistent product-cloud provider. Authentication checks, IndexedDB,
outbox delivery, and synchronization therefore survive navigation between resource routes. Route
components consume that runtime; they do not instantiate independent cloud clients.

The selected organization is device presentation state, persisted locally and passed to the cloud
client as an authorized request scope. It is not encoded as a route parameter and cannot be opened
by typing an organization ID into the address bar.

## Mobile

The Expo client uses React Navigation 7 native stack navigation. Its root navigator conditionally
installs the signed-out, organization-selection, or authenticated route set from the validated
cloud session. Protected project, thread, artifact, and note screens do not exist in the signed-out
navigator. The navigation container remains mounted across phase changes, preserving deep-link and
navigation ownership without restarting the cloud runtime. Expo deep linking maps the same route
concepts to the `dev.glass.mobile` scheme.

Mobile does not import the DOM renderer or TanStack Router. Navigation state remains native, while
the cloud contracts, Better Auth session model, product synchronization, and organization scope
remain shared concepts.

The mobile composition root installs a persistent product-cloud provider outside the navigator.
Feature ownership is explicit:

- `src/navigation/` owns typed routes, deep links, and route-set authority.
- `src/product-cloud/` owns session, organization scope, cache, outbox, and synchronization.
- `src/screens/` owns native route presentation and resource interactions.
- `src/execution/` owns optional Glass Connect and machine-capability presentation.
- `src/ui/` owns native-only primitives and styles.

`apps/mobile/AGENTS.md` and the repository architecture test enforce these boundaries.

## Source map

- Web router: `apps/web/src/main.tsx`, `apps/web/src/router.ts`, `apps/web/src/routes/`
- Electron history selection: `apps/web/src/main.tsx`
- Desktop host: `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`
- Mobile composition root: `apps/mobile/src/App.tsx`
- Mobile navigator and deep links: `apps/mobile/src/navigation/`
- Mobile product runtime: `apps/mobile/src/product-cloud/`
- Device-selected organization state: `apps/web/src/product-cloud/indexed-db.ts`,
  `apps/mobile/src/cloud/storage.ts`
