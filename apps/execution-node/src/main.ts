import { readExecutionDescriptor } from "@glass/execution-core/capabilities";
import { Effect } from "effect";

const descriptor = await Effect.runPromise(readExecutionDescriptor);
process.stdout.write(`${JSON.stringify(descriptor)}\n`);
