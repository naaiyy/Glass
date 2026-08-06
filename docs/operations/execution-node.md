# Execution node operations

> Audience: operators and contributors publishing a capable computer through Glass Connect.

The execution node makes explicitly registered local workspaces available through a remotely
managed, outbound per-environment Cloudflare Tunnel. It binds its origin to loopback, supervises a
pinned checksum-verified connector, and never opens an SSH server, accepts a manually entered
endpoint, or becomes the Glass product backend.

## Build and publish

```sh
vp run --filter @glass/execution-node build
node apps/execution-node/dist/main.js pair \
  --api https://your-glass-cloud.example \
  --name "Build Mac"
```

The command creates a machine-held Ed25519 key, prints a short-lived pairing code and approval
link, and waits. Open the link, sign in if needed, select the organization, and enter the printed
code under **Glass Connect**. The link targets `/#glass-connect-pair`; no pairing code, polling
token, credential, or key is placed in the URL.

The Cloudflare deployment serves the renderer with single-page-application fallback, so the root
entry and fragment resolve in production. If no organization is active, select one first; the
fragment remains in the URL and the renderer focuses the pairing-code control when it appears.

## Register workspaces and connect

Every workspace has a stable UUID, a display name, and an absolute directory owned by this
execution environment:

```sh
node apps/execution-node/dist/main.js workspace-add \
  --id 11111111-1111-4111-8111-111111111111 \
  --name "Glass" \
  --root /absolute/path/to/Glass
node apps/execution-node/dist/main.js connect
```

The environment-owned registry is stored at `~/.glass/execution-workspaces.json` with owner-only
permissions. Use `workspace-list` to inspect it and `workspace-remove --id UUID` to revoke a local
registration. Set `GLASS_EXECUTION_WORKSPACES_PATH`, or pass `--workspaces`, to use another registry.
`GLASS_EXECUTION_WORKSPACES` remains an explicit process-local JSON override for automation and
does not replace the durable registry.

Set `GLASS_EXECUTION_STATE_ROOT` to override the local checkpoint and operation-journal directory.
Set `GLASS_NODE_IDENTITY_PATH`, or pass `--identity`, to override the default
`~/.glass/execution-node.json`. The identity file is written atomically with owner-only permissions.

From the repository root, every complete client development entry (`vp run dev`, `dev:desktop`,
and `dev:mobile`) automatically builds and resumes the execution node when the identity and
workspace registry are both present. The client remains connected to Glass Cloud while the node
starts or reconnects; no second terminal owns the execution process.

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

1. Run the pairing command and confirm the approval URL contains only the
   `#glass-connect-pair` fragment—never the displayed code.
2. Approve the displayed code in a signed-in organization.
3. Start the node with a registered workspace and wait for `online`. Confirm the local origin listens
   only on `127.0.0.1` and the public proxied hostname reaches it only through the managed connector.
4. On another signed-in web, desktop, or mobile client, open the same organization and confirm the
   environment reports `online`.
5. As an organization administrator, load the environment's advertised workspaces and bind one to
   a project. On another authorized device, select that durable binding without re-entering its
   UUID and choose **Connect**. Confirm the scoped directory-list operation completes.
6. Through the typed operation API, verify a bounded file read and atomic write, a streamed command,
   a PTY open/input/resize/close sequence, Git status/diff and an allowlisted mutation, and checkpoint
   create/list/restore. Confirm each terminal result is durable and reconciles after reconnect.
7. Start a command that ignores graceful termination, cancel it, and confirm the process group is
   forcibly terminated within the configured bound and the durable operation becomes `cancelled`.
8. Stop the node and confirm product records remain available while execution reports offline.
9. Restart the node and verify reconnection. Rotate its key and verify old tickets and sessions
   fail. Revoke it and verify active sockets close, unused tickets fail, workspace discovery
   disappears, connector/origin processes stop, provider cleanup converges, and no new operation
   reaches the machine.
