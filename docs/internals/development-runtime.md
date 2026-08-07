# Development runtime

> **Audience:** Glass maintainers working on client surfaces, authentication, or execution.

Development launches a complete client, not an isolated renderer. One root orchestrator selects the
web, desktop, or mobile surface, verifies the real development Glass Cloud health and authentication
boundaries, supplies surface configuration, resumes a matching execution node when configured, and
owns child-process shutdown.

## Surface entries

- `vp run dev` and `vp run dev:web` start Vite, open the local browser application, and proxy
  product traffic to development Glass Cloud.
- `vp run dev:desktop` starts the same live Vite renderer without opening a browser, then loads it
  through the Electron host and authenticated preload boundary.
- `vp run dev:mobile` owns Metro with the development Glass Cloud origin. `dev:mobile:ios` also
  builds, installs, and opens the native iOS app, then keeps Metro and Glass Connect alive after the
  one-shot native launcher exits. Parallel worktrees select the next available Metro port.

The workspace-level client `dev` scripts delegate to the same orchestrator. Their lower-level
`start:vite`, `start:metro`, and `start:ios` tasks are orchestration building blocks, not complete
developer entries. API-only and execution-node-only commands remain diagnostics.

## Browser topology

Vite binds to a dynamically selected `127.0.0.1` port and serves the live renderer with HMR. It
proxies `/api`, `/v1`, and `/health` to the selected Glass Cloud origin. Browser code therefore uses
one local origin while every product record is still authenticated, authorized, and stored by
Glass Cloud. The proxy never targets the execution node and never makes execution the product
backend.

Local GitHub sign-in uses Better Auth's OAuth proxy plugin. Vite marks only proxied `/api` requests
with the validated loopback origin. The development Worker removes that internal header and presents
the loopback request URL to the plugin while retaining the stage-scoped Cloud host as Better Auth's
provider callback authority. GitHub returns to the registered Cloud callback; Better Auth then
returns a short-lived encrypted OAuth profile to the loopback callback, where the local-origin
session cookie is created. Staging and production do not trust or interpret the development header
or loopback callback origin.

## Connection independence

The orchestrator always selects development Glass Cloud unless `GLASS_CLOUD_ORIGIN` is explicitly
set. An execution identity cannot silently select staging or production. A missing, unrelated, or
workspace-less identity is reported without blocking the product connection. When a matching
identity and workspace registry exist, the orchestrator builds and owns the execution node so no
second terminal is required.

Development execution state defaults to `~/.glass/development/`, separate from the default
published identity used by packaged or production workflows. Publish and register this machine once
with the development paths; subsequent client launches resume it automatically:

```sh
vp run --filter @glass/execution-node build
node apps/execution-node/dist/main.js pair \
  --api https://glasscloud-api-dev-iqwgnfdineqiceki.naaiyyyy.workers.dev \
  --identity ~/.glass/development/execution-node.json \
  --name "Development Mac"
node apps/execution-node/dist/main.js workspace-add \
  --identity ~/.glass/development/execution-node.json \
  --id 11111111-1111-4111-8111-111111111111 \
  --name "Glass" \
  --root /absolute/path/to/Glass
```

## Failure behavior

- Cloud health or authentication failure stops before a client opens.
- A required child process exiting unexpectedly stops the process tree.
- Closing the selected primary surface or pressing `Ctrl+C` terminates owned helpers.
- Execution availability remains separate from product availability; the launcher never invents an
  identity, credential, workspace, or local product store.

## Native iOS lifecycle

The checked-in `apps/mobile/ios` host is authoritative native source, not a disposable local build
artifact. Xcode 27 requires UIKit's scene lifecycle. `AppDelegate` owns process-wide Expo and React
Native factory initialization, while `SceneDelegate` owns the `UIWindow`, starts React Native for
the connecting scene, forwards scene lifecycle events to Expo subscribers, and preserves cold-start
URL and universal-link delivery. The scene manifest names that delegate explicitly. Regenerating the
native project without preserving this boundary is not a supported development operation.

## Source map

- Surface orchestrator: `scripts/dev-runner.mjs`
- Root surface entries: `package.json`
- Browser proxy: `apps/web/vite.config.ts`
- Browser authentication client: `apps/web/src/auth-client.ts`
- Development OAuth boundary: `apps/api/src/auth.ts`, `apps/api/src/env.ts`
- Desktop host and preload: `apps/desktop/src/`
- Mobile cloud configuration: `apps/mobile/src/cloud/`
- Mobile iOS process and scene lifecycle: `apps/mobile/ios/Glass/AppDelegate.swift`,
  `apps/mobile/ios/Glass/SceneDelegate.swift`, `apps/mobile/ios/Glass/Info.plist`
- Execution identity and workspace registry: `apps/execution-node/src/`
