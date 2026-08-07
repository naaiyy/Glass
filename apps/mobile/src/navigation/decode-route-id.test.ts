import type { ProjectId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";

import { decodeRouteId } from "./decode-route-id.ts";

describe("mobile route ID decoding", () => {
  it("brands canonical IDs at the navigation boundary", () => {
    const value = "00000000-0000-4000-8000-000000000001";
    expect(decodeRouteId<ProjectId>(value, "$projectId")).toBe(value);
  });

  it("rejects malformed deep-link IDs before resource access", () => {
    expect(decodeRouteId<ProjectId>("project-by-name", "$projectId")).toBeNull();
  });
});
