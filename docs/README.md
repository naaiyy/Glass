# Glass documentation

Glass documentation is organized by audience. Milestones 0 through 2 establish the architectural
constitution, runnable monorepo, and deployed Glass Cloud foundation. This repository contains the
deployed Milestone 3 durable product-core and synchronization implementation. Development,
staging, and production serve the shared web renderer and product API from one Worker origin, and
the production Better Auth GitHub lifecycle has passed live verification.
Environment pairing, Glass Connect, machine execution, production-ready multi-user product
experiences, and releases remain later milestones unless a page explicitly says otherwise. Editor
collaboration has no Glass implementation milestone; it remains owned by OpenEditor and arrives in
Glass only through a coordinated OpenEditor dependency update.

## Internals

For maintainers and contributors:

- [System overview](internals/overview.md)
- [Product cloud](internals/product-cloud.md)
- [Durable product core](internals/durable-product-core.md)
- [Product synchronization and outbox](internals/synchronization.md)
- [OpenEditor integration](internals/openeditor.md)
- [Execution environments](internals/execution-environments.md)
- [Connection runtime](internals/connection-runtime.md)
- [Orchestration](internals/orchestration.md)
- [Environment authentication](internals/environment-auth.md)
- [Glass Connect](internals/glass-connect.md)
- [Workspace layout](internals/workspace-layout.md)
- [Glossary](internals/glossary.md)
- [Continuous integration](internals/ci.md)

## Operations

For infrastructure, deployment, and release owners:

- [Cloud infrastructure](operations/cloud-infrastructure.md)
- [Releases](operations/releases.md)

Milestone 2 cloud provisioning and Milestone 3 web/API deployment are operational as described in
the cloud runbook. Desktop signing, store publication, and later release workflows are not implied
by that deployment.

## User guides

For people using Glass:

- [Remote access](user/remote-access.md)

User guides describe shipped behavior only. The remote-access page currently records availability rather than presenting an unimplemented setup flow.
