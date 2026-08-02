# Orchestration

> **Audience:** Glass maintainers and contributors designing product-to-execution workflows.

Orchestration coordinates durable cloud intent with optional environment execution without moving product authority into the execution node.

## Responsibility split

Glass Cloud accepts authorized product intent, records durable execution metadata, assigns stable operation identifiers, and records durable results. The execution node validates its scoped authority, performs only advertised and allowed machine work, and reports typed progress or terminal results. The device renders both sources without becoming the durable coordinator.

`packages/execution-core` contains pure execution concepts and orchestration decisions that are safe to share with the Node runtime. It does not contain a server, database client, UI state, or product authentication shortcut.

## Required behavior for future execution work

- Commands and results use versioned contracts and stable identifiers.
- Acceptance is distinct from completion.
- Delivery may repeat; handlers are idempotent.
- Cancellation and timeout are explicit terminal outcomes.
- The node reports unsupported capabilities as typed errors rather than pretending success.
- Durable metadata/results reach cloud-owned storage; required state never exists only in memory.
- Environment loss leaves the product usable and the operation state honest.
- Reconnection does not infer that an interrupted process completed.

The execution foundation exposes descriptors and boundaries only. It does not dispatch commands,
run agents, persist executions, or implement an execution event model. Milestone 3 product change
events belong to Glass Cloud synchronization and do not authorize or represent machine execution.

## Source map

- Execution orchestration domain: `packages/execution-core/src/`
- Cross-runtime contracts and typed errors: `packages/contracts/src/`
- Cloud coordinator boundary, when implemented: `apps/api/src/`
- Machine adapter boundary, when implemented: `apps/execution-node/src/`
