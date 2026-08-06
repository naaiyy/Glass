import { describe, expect, it } from "vite-plus/test";

import { tunnelRequiresDeletion } from "./tunnel-cleanup.ts";

describe("tunnel cleanup", () => {
  it("does not delete a tunnel that Cloudflare already soft-deleted", () => {
    expect(tunnelRequiresDeletion({ deletedAt: "2026-08-03T19:51:51.586366Z" })).toBe(false);
  });

  it("deletes an active tunnel", () => {
    expect(tunnelRequiresDeletion({ deletedAt: null })).toBe(true);
    expect(tunnelRequiresDeletion({})).toBe(true);
  });
});
