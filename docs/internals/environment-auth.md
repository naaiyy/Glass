# Environment authentication

> **Audience:** Glass maintainers and security reviewers working on environment trust.

Environment authentication establishes which registered execution node is connecting. Authorization separately establishes which organization, project, workspace, and capabilities it may access. Network reachability, pairing state, or possession of a WebSocket URL is not sufficient authority.

## Trust requirements

The authentication milestone requires:

- real Glass Cloud user authentication for pairing approval
- a unique environment key protected by the execution environment
- revocable environment registration and pairing records owned by Glass Cloud
- scoped, audience-bound, short-lived credentials
- DPoP-style proof of possession bound to request method, target, time, and a unique nonce or identifier
- short-lived, single-purpose WebSocket tickets
- replay detection, clock-skew bounds, key rotation, and explicit revocation
- server-side authorization for every protected project, environment, workspace, and capability

Secrets and proof material never appear in logs, query strings, analytics, fixtures, or source control. Pairing codes are short-lived invitations, not durable bearer credentials.

## Lifecycle

Pairing begins only after a signed-in user explicitly approves an environment. Glass Cloud records the environment and grants no broader scope than the approved relationship. The node proves possession of its key when exchanging for scoped credentials and tickets. Revocation terminates future exchanges and active transport where feasible. Re-pairing creates new trust material rather than reviving a revoked secret.

## Foundation status

Environment authentication is not implemented in the foundation. The API health/descriptor surface and execution capability descriptor are public foundation boundaries and do not simulate an authenticated product feature. Work requiring credentials or external authority remains blocked until real services and secrets exist.

## Source map

- Future authentication contracts: `packages/contracts/src/`
- Future cloud authentication and authorization: `apps/api/src/`
- Future environment credential handling: `apps/execution-node/src/`
- Future infrastructure secrets and bindings: `infra/cloud/`
