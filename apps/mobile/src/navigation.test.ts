import { describe, expect, it } from "vite-plus/test";

import { resolveMobileRouteSet } from "./navigation.ts";

describe("mobile route authority", () => {
  it("does not install protected routes without authenticated organization scope", () => {
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
    ).toBe("organizations");
  });

  it("keeps organization selection authoritative when an attention scope remains", () => {
    expect(
      resolveMobileRouteSet({
        authenticated: true,
        organizationSelected: true,
        phase: "organization-selection",
      }),
    ).toBe("organizations");
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
