# Execution node operations

> Audience: operators and contributors publishing a capable computer through Glass Connect.

The execution node makes explicitly registered local workspaces available through a remotely
managed, outbound per-environment Cloudflare Tunnel. It binds its origin to loopback, supervises a
pinned checksum-verified connector, and never opens an SSH server, accepts a manually entered
endpoint, or becomes the Glass product backend.

## Publish and connect

```sh
npx glass-connect@latest
```

Run the command from the folder to make available to Glass. The launcher registers that folder,
creates a machine-held Ed25519 key, and prints a short-lived pairing code. Open
**Settings → Environments → Publish computer** and enter the code. After approval, the same process
completes publication, starts the managed connector, and remains online. Running the same command
later resumes the existing identity instead of pairing again.

There are no project or permission choices: a published environment is eligible for every
organization project and supported execution capability. The approval link targets
`/#glass-connect-pair`; no pairing code, polling token, credential, or key is placed in the URL.

The Cloudflare deployment serves the renderer with single-page-application fallback, so the root
entry and fragment resolve in production. If no organization is active, select one first; the
fragment remains in the URL and the renderer focuses the pairing-code control when it appears.

## Manage additional folders

Run `npx glass-connect@latest` from another folder to add it to the folders available from this
computer. The normal product flow discovers these folders automatically from a project.

Every workspace has a stable UUID, a display name, and an absolute directory owned by this
execution environment:

```sh
node apps/execution-node/dist/main.js workspace-add \
  --id 11111111-1111-4111-8111-111111111111 \
  --name "Glass" \
  --root /absolute/path/to/Glass
```

The environment-owned registry is stored at `~/.glass/execution-workspaces.json` with owner-only
permissions. Use `workspace-list` to inspect it and `workspace-remove --id UUID` to revoke a local
registration. Operators may set `GLASS_EXECUTION_WORKSPACES_PATH` to use another registry.
`GLASS_EXECUTION_WORKSPACES` remains an explicit process-local JSON override for automation and
does not replace the durable registry.

Set `GLASS_EXECUTION_STATE_ROOT` to override the local checkpoint and operation-journal directory.
Operators may set `GLASS_NODE_IDENTITY_PATH` to override the default
`~/.glass/execution-node.json`. The identity file is written atomically with owner-only permissions.

From the repository root, every complete client development entry (`vp run dev`, `dev:desktop`,
and `dev:mobile`) automatically builds and resumes a matching published execution node even when
it has no registered workspace. The client remains connected to Glass Cloud while the node starts
or reconnects; no second terminal owns the execution process.

Glass Cloud reports the environment online after the managed connector starts. The node binds its
execution WebSocket origin only to an ephemeral `127.0.0.1` port and obtains a proof-bound managed
tunnel configuration from Glass Cloud. On first connect, it downloads only the repository-pinned
connector asset for the current platform, verifies its SHA-256 digest before installation, and
starts it with fixed arguments. The connector token remains in process memory and is passed to the
child only through `TUNNEL_TOKEN`; it is never written to the identity file, command arguments, or
logs. Connector output and restart attempts are bounded and secret-redacted. Reconnect uses bounded
exponential backoff with jitter. Revoking the environment stops both connector and loopback origin;
publish it again to establish a new trust relationship.

Clients reach the environment hostname directly through the managed tunnel. A one-time client
ticket is consumed before the loopback origin accepts the WebSocket upgrade. The origin selects
only the public `glass-connect-v2` protocol, then signs a ticket-, session-, hostname-, nonce-, and
key-version-bound welcome with the environment key. Clients remain unauthenticated and cannot send
operations until that signature is verified. Every request is durably claimed by Glass Cloud
before machine side effects, and every progress or result frame is locally journaled and durably
ingested before it is forwarded to the client.

## Manual verification

1. Run `npx glass-connect@latest` and confirm the approval URL contains only the
   `#glass-connect-pair` fragment—never the displayed code.
2. Approve the displayed code in a signed-in organization. Confirm there are no project or
   permission choices in the pairing flow.
3. Keep the command running and wait for `online`. Confirm the local origin listens
   only on `127.0.0.1` and the public proxied hostname reaches it only through the managed connector.
4. On another signed-in web, desktop, or mobile client, open the same organization and confirm the
   environment reports `online`.
5. Open a project and choose one of the environment's advertised folders. Confirm the environment
   can be used by any project in the organization, and
   that Glass Cloud rejects operations without the matching workspace binding.
6. Through the typed operation API, verify a bounded file read and atomic write, a streamed command,
   a PTY open/input/resize/close sequence, Git status/diff and an allowlisted mutation, and checkpoint
   create/list/restore. Confirm each terminal result is durable and reconciles after reconnect.
7. Start a command that ignores graceful termination, cancel it, and confirm the process group is
   forcibly terminated within the configured bound and the durable operation becomes `cancelled`.
8. Stop the node and confirm product records remain available while execution reports offline.
9. Restart the node and verify reconnection. Revoke it and verify active sockets close, unused
   tickets fail, workspace discovery
   disappears, connector/origin processes stop, provider cleanup converges, and no new operation
   reaches the machine.
