import { describe, expect, it } from "vite-plus/test";
import { initialConnectionState } from "./connections.ts";

describe("connection runtime", () => {
  it("models optional execution independently from the product connection", () => {
    expect(initialConnectionState()).toEqual({
      product: { status: "connecting" },
      execution: { status: "not-configured" },
    });
  });
});
