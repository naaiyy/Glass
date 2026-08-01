import { glassProtocolVersion, type ExecutionNodeDescriptor } from "@glass/contracts/architecture";
import { Effect } from "effect";

export class ExecutionCapabilityUnavailable extends Error {
  readonly code = "EXECUTION_UNAVAILABLE";
  readonly capability: string;
  readonly retryable = true;

  constructor(capability: string) {
    super(`Execution capability is not available: ${capability}`);
    this.capability = capability;
    this.name = "ExecutionCapabilityUnavailable";
  }
}

export const foundationExecutionDescriptor = (): ExecutionNodeDescriptor => ({
  kind: "execution-node",
  protocolVersion: glassProtocolVersion,
  capabilities: [],
  status: "foundation",
});

export const readExecutionDescriptor = Effect.sync(foundationExecutionDescriptor);
