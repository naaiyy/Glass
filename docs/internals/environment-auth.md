# Environment authentication

> **Audience:** Glass maintainers and security reviewers working on environment trust.

Environment authentication establishes which registered execution node is connecting. Authorization separately establishes which organization, project, workspace, and capabilities it may access. Network reachability, pairing state, or possession of a WebSocket URL is not sufficient authority.

## Trust boundary

- real Glass Cloud user authentication for pairing approval
- a unique environment key protected by the execution environment
- revocable environment registration and pairing records owned by Glass Cloud
- scoped, audience-bound, short-lived credentials
- Ed25519 proof of possession over purpose-specific, expiring server challenges
- single-consumption pairing, credential, and rotation challenges
- key-version-bound credentials scoped to the `glass-connect` audience
- key rotation and explicit revocation that invalidate outstanding credentials
- server-side organization administrator checks for approval, rotation, and revocation
- append-only security events for pairing request, approval, completion, credential issuance,
  rotation, and revocation
- bounded unauthenticated pairing and credential challenge creation

Short-lived, single-purpose WebSocket tickets, atomic ticket consumption before WebSocket upgrade,
and proof-bound presence are the Glass Connect boundary built on this identity. The node signs its
welcome with the current environment key. Project, workspace, and capability authorization are
evaluated again before machine side effects; publication does not supply those grants.

Secrets and proof material never appear in logs, query strings, analytics, fixtures, or source control. Pairing codes are short-lived invitations, not durable bearer credentials.

## Lifecycle

Glass Cloud sign-in and environment publishing are separate security events. Sign-in authenticates a user, restores cloud-owned product access, and makes environments already authorized through organization membership discoverable. It never silently turns the current device into an execution environment.

The execution node creates an Ed25519 key pair locally and stores its identity file with owner-only
permissions. It requests a short-lived pairing code and a separate high-entropy polling secret.
The code is entered into the signed-in Glass publishing panel; it is never embedded in the approval
URL. An organization owner or administrator approves the request. The node polls with the secret,
signs the approved server challenge, and only then receives its durable environment record.

The approving user is the audited actor and the organization is the durable authorization
boundary. Another browser, phone, or desktop signed into an authorized organization can list the
published environment without publishing that device.

The node signs a fresh credential challenge to receive a 15-minute `glass-connect` credential. Glass
Cloud stores only its hash and binds it to the current environment key version. The raw credential
and private key remain in the environment-owned identity file. A credential alone is insufficient
to mint connection authority; the node also signs the one-time Glass Connect challenge.

Rotation is a two-party ceremony. The node first authenticates with its current proof-bound
credential and stages a replacement key locally. A current organization administrator explicitly
approves the short-lived rotation code. Completion requires signatures from both the current and
replacement private keys over the approved one-time challenge. Glass Cloud atomically installs the
replacement public key, increments the key version, consumes the ceremony, and revokes every
outstanding credential. The node keeps the staged key across retries and promotes it only after
Cloud confirms completion, including an idempotent retry after a lost response.

Revocation is a separate audited, transactional operation that increments the key version, revokes
credentials, consumes active challenges, and prevents future environment authorization. Signing
out a device does not silently revoke an organization environment. Revocation also forces the
environment connector and loopback origin to stop and schedules durable deletion of its remotely
managed tunnel and DNS record.

Pairing is the trust operation within publishing; it is not SSH, a tunnel, or another transport. Network setup occurs through Glass Connect only after trust has been established.

Environment registration, pairing approval, proof of possession, credential exchange, listing,
rotation, revocation, and security auditing are implemented and covered by focused contract, API,
schema, and node-identity tests. The committed migration adds the durable environment identity and
security-event tables. Production publishing, credential exchange, two-key rotation, revocation,
and idempotent recovery after a lost completion response have passed live verification.

Cloudflare Rate Limit bindings protect unauthenticated trust mutations and polling independently.
Mutations allow 20 requests per minute per Cloudflare client IP and API host. Status polling allows
120 requests per minute so the node's two-second polling interval remains viable. Exhausted limits
return `429` with `Retry-After: 60`; a deployed Worker without a required binding fails closed.

## Source map

- Environment contracts and validation: `packages/contracts/src/environments.ts`
- Environment identifiers: `packages/contracts/src/ids.ts`
- Cloud trust and credential service: `apps/api/src/environment-service.ts`
- Authenticated and node-facing routes: `apps/api/src/index.ts`
- Durable schema and security events: `apps/api/src/db/schema.ts`
- Contract tests: `packages/contracts/src/environments.test.ts`
- API and service tests: `apps/api/src/environment-routes.test.ts`, `apps/api/src/environment-service.test.ts`
- Node key storage, pairing, and credential exchange: `apps/execution-node/src/identity.ts`
- Node identity tests: `apps/execution-node/src/identity.test.ts`
- Tunnel proof and ticket authority: `apps/api/src/connect-authority.ts`, `apps/api/src/tunnel-service.ts`
- Web approval and management UI: `apps/web/src/product-cloud/EnvironmentPanel.tsx`
- Web cloud adapter: `apps/web/src/product-cloud/environment-cloud.ts`
- Committed migrations: `infra/cloud/migrations/postgres/`
