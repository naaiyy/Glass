import { describe, expect, it, vi } from "vite-plus/test";

import { createNodeIdentity } from "./identity.ts";
import { createTunnelControl } from "./tunnel-control.ts";

describe("tunnel control", () => {
  it("aborts a stalled proof-bound control request", async () => {
    const base = createNodeIdentity("https://api.glass.test");
    const identity = {
      ...base,
      environment: {
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
        revokedAt: null,
      },
      credential: {
        token: "credential",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    } as never;
    vi.stubGlobal(
      "fetch",
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const control = createTunnelControl(
      { load: async () => identity, save: async () => undefined },
      { requestTimeoutMilliseconds: 20 },
    );
    await expect(control.validateTicket("t".repeat(43))).rejects.toThrow();
  });
});
