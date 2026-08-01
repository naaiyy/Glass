import { describe, expect, it } from "vite-plus/test";
import { foundationExecutionDescriptor } from "./capabilities.ts";

describe("execution capabilities", () => {
  it("does not advertise unimplemented machine capabilities", () => {
    expect(foundationExecutionDescriptor().capabilities).toEqual([]);
  });
});
