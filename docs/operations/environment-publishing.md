# Environment publishing operations

> Audience: Glass Cloud operators and security responders responsible for execution-environment trust.

## Current status

Production implements durable environment registration, administrator approval, Ed25519 proof
of possession, short-lived scoped credential exchange, two-key rotation, revocation, and append-only
security events, the managed tunnel lifecycle, and the direct execution protocol. The production
path has passed live publishing, credential, rotation, managed-tunnel, direct WebSocket,
durable-result, and cleanup verification.

## Required cloud bindings

Every deployed API Worker requires the normal Glass Cloud authentication and database bindings plus:

- `CONNECT_AUTHORITY`, the Durable Object namespace used only for proof freshness and ticket
  generation; execution frames do not traverse it
- `CONNECT_TICKET_SECRET`, a secret of at least 32 bytes
- `CONNECT_TUNNEL_ZONE_NAME`, the active Cloudflare DNS zone used for stage-scoped Connect names
- `TUNNEL_CONTROL`, the private service binding whose runtime token may create, configure,
  disconnect, and delete remotely managed tunnels and proxied DNS records in that zone
- `TRUST_MUTATION_RATE_LIMIT`, configured for 20 requests per 60 seconds
- `TRUST_POLL_RATE_LIMIT`, configured for 120 requests per 60 seconds
- `CONNECT_NODE_RATE_LIMIT`, configured for 10,000 authenticated node-control requests per 60
  seconds and keyed by environment and credential

Before planning a Glass Connect deployment, the selected Cloudflare account must contain an active
DNS zone with working delegation. The deployment identity must be able to deploy Workers, Durable
Objects, service bindings, and runtime API-token bindings. The tunnel-control runtime identity must
have least-privilege Tunnel Write and DNS Write access restricted to the selected account and zone.
PlanetScale migration authority and the normal stage-specific Better Auth and OAuth secrets must
also be present. A Cloudflare account with no active zone cannot host a production Connect hostname;
a temporary or randomly assigned quick tunnel is not an acceptable substitute.

Each stage supplies its intended zone through `CONNECT_TUNNEL_ZONE_NAME`. Review the generated
hostnames and provider plan to confirm that development, staging, and production resources remain
isolated.

Pairing, credential, and rotation mutations use the lower client-IP-and-host limit. Pairing and
rotation status polls use the separate higher limit. Authenticated node challenges and control
requests use the environment-and-credential limiter so durable result delivery cannot exhaust the
public trust buckets. Each deployment stage uses deterministic, distinct Cloudflare
rate-limit namespaces, so test traffic cannot consume production capacity. An exhausted limit
returns `429` and `Retry-After: 60`; a
missing binding makes public environment-trust routes fail closed with `503`.

Never place private keys, raw credentials, pairing or rotation polling tokens, proof signatures,
ticket secrets, or challenge payloads in deployment output, logs, analytics, fixtures, or incident
notes.

## Deployment verification

After reviewing and applying the committed migration chain and Cloudflare plan:

1. Confirm all three Rate Limit bindings, `CONNECT_AUTHORITY`, `TUNNEL_CONTROL`, the ticket secret,
   tunnel zone name, Hyperdrive, and Better Auth bindings are present on the deployed Worker.
   Confirm the selected DNS zone is active and delegated before publishing an environment.
2. Publish a disposable execution environment. Verify the approval requires a real signed-in
   organization administrator and that a different authorized device can list the environment.
3. Exchange a credential, then replay the consumed proof challenge and require rejection.
4. Rotate the environment key. Require administrator approval and proofs from both the current and
   replacement keys; verify old credentials no longer work and an idempotent completion retry
   returns the rotated environment.
5. Start the node and verify that exactly one remotely managed tunnel exists for the disposable
   environment, its stage-scoped CNAME is proxied, ingress targets only the reported loopback
   origin, and the fallback ingress returns `404`. Confirm the node never logs or persists the
   connector token.
6. From a second signed-in device, obtain a one-time ticket and connect through the public hostname.
   Confirm the ticket is carried in the WebSocket subprotocol rather than the URL, replay fails,
   the node welcome verifies against the environment key, and execution frames do not traverse the
   API Worker or Durable Object.
7. Revoke the environment. Verify it disappears from authorized discovery, active connectivity is
   disconnected, credential exchange fails, the connector and loopback origin stop, and provider
   tunnel/DNS cleanup converges after retry.
8. Inspect security events for the request, approval, completion, credential, rotation, and
   revocation actors and timestamps. Confirm no secret or proof material appears in metadata.
9. Exercise more than 20 trust mutations from one test source within a minute and require `429`
   with `Retry-After: 60`. Separately confirm two-second status polling is not charged to that
   mutation bucket.

Use a disposable organization and environment for live verification. Revocation is the cleanup
step; deleting or signing out a client session is not a substitute.

## Recovery and response

- Lost environment identity file: revoke the environment from an authorized administrator session,
  then publish it as a new environment. Glass Cloud cannot recover its private key.
- Suspected private-key exposure: revoke immediately. Do not rely on credential expiry alone.
- Interrupted rotation: rerun the node rotation command. The staged replacement key and ceremony
  survive process restart; completion is retry-safe after Cloud commits.
- Unexpected request flood: retain the Rate Limit bindings, review aggregate Cloudflare telemetry
  and secret-free security events, and revoke affected environments where trust may be compromised.
- Offline or revoked node: keep Glass Cloud product access available and report execution as
  unavailable. Do not route product requests through another environment.

## Source map

- Cloud bindings and DNS scope: `infra/cloud/alchemy.run.ts`
- Tunnel-control Worker: `infra/cloud/src/tunnel-control-worker.ts`
- Trust routes and rate-limit enforcement: `apps/api/src/index.ts`
- Durable trust service: `apps/api/src/environment-service.ts`
- Schema and audit records: `apps/api/src/db/schema.ts`
- Environment-held identity: `apps/execution-node/src/identity.ts`
- Tunnel lifecycle and authority: `apps/api/src/tunnel-service.ts`, `apps/api/src/connect-authority.ts`
- Node connector and loopback origin: `apps/execution-node/src/cloudflared.ts`, `apps/execution-node/src/tunnel-origin.ts`
- Execution-node commands: `apps/execution-node/src/main.ts`
- Migrations: `infra/cloud/migrations/postgres/`
