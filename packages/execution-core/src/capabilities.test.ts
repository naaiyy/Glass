import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import {
  foundationExecutionDescriptor,
  readExecutionDescriptor,
  readyExecutionDescriptor,
} from "./capabilities.ts";

describe("execution capabilities", () => {
  it("does not advertise unimplemented machine capabilities", () => {
    expect(foundationExecutionDescriptor().capabilities).toEqual([]);
  });

  it("advertises only implemented runtime capabilities when ready", () => {
    expect(readyExecutionDescriptor()).toMatchObject({
      status: "ready",
      capabilities: ["filesystem", "git", "processes", "terminals", "workspace-checkpoints"],
    });
  });

  it("uses the ready descriptor for the runnable execution node handshake", async () => {
    await expect(Effect.runPromise(readExecutionDescriptor)).resolves.toMatchObject({
      status: "ready",
      capabilities: ["filesystem", "git", "processes", "terminals", "workspace-checkpoints"],
    });
  });
});
