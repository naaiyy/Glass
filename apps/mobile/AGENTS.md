# Glass mobile architecture

These rules extend the repository-wide architecture for the native Expo client.

- `src/App.tsx` is a composition root only. It installs persistent application providers and the
  root navigator; it does not own screens, transport, synchronization, execution, or styling.
- `src/navigation/` owns typed route declarations, deep-link mapping, route authority, and native
  navigator composition. Navigation modules do not call cloud or execution transports.
- `src/product-cloud/` owns the Better Auth-backed product session, organization scope, validated
  cache, synchronization engine, and product-command outbox. Its provider stays mounted outside
  the navigator so route transitions never restart those runtimes.
- `src/screens/` owns route-level native presentation. A screen may call an explicit authenticated
  adapter for its resource, such as OpenEditor note load/save, but it must not create product sync,
  outbox, or execution runtimes.
- `src/execution/` owns optional execution-environment discovery and Glass Connect behavior. It
  must not become an authority for cloud-owned product records.
- `src/ui/` contains native-only presentation primitives and styles. It never imports DOM UI.
- New deep-link identifiers remain strings at the React Navigation boundary and are decoded into
  branded contract IDs before lookup or transport use.

Prefer direct feature imports. Do not add a broad mobile barrel file that hides ownership or
creates dependency cycles.
