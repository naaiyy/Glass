import { describe, expect, it } from "vite-plus/test";
import { handleRequest } from "./index.ts";

describe("Glass Cloud API boundary", () => {
  it("exposes an honest foundation descriptor", async () => {
    const response = handleRequest(new Request("https://glass.invalid/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      architecture: { kind: "glass-cloud", status: "foundation" },
      service: "glass-api",
    });
  });
});
