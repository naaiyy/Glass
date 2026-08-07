import { describe, expect, it } from "vite-plus/test";

import { resolveMobileRouteSet } from "./navigation.ts";

describe("mobile route authority", () => {
  it("keeps signed-out users out and organization selection on the product workspace", () => {
    expect(
      resolveMobileRouteSet({
        authenticated: false,
        organizationSelected: false,
        phase: "signed-out",
      }),
    ).toBe("auth");
    expect(
      resolveMobileRouteSet({
        authenticated: true,
        organizationSelected: false,
        phase: "organization-selection",
      }),
    ).toBe("product");
  });

  it("keeps organization selection inside the product route set", () => {
    expect(
      resolveMobileRouteSet({
        authenticated: true,
        organizationSelected: true,
        phase: "organization-selection",
      }),
    ).toBe("product");
  });

  it("installs product routes for live and cached offline organization state", () => {
    expect(
      resolveMobileRouteSet({
        authenticated: true,
        organizationSelected: true,
        phase: "live",
      }),
    ).toBe("product");
    expect(
      resolveMobileRouteSet({
        authenticated: true,
        organizationSelected: true,
        phase: "offline",
      }),
    ).toBe("product");
  });
});
