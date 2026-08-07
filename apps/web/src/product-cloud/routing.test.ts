import { describe, expect, it } from "vite-plus/test";

import { resolveWebProductDestination } from "./routing.ts";

describe("web route authority", () => {
  it("redirects signed-out users away from protected routes", () => {
    expect(
      resolveWebProductDestination({
        authenticated: false,
        organizationSelected: true,
        pathname: "/workspace/notes/note-id",
        status: "signed-out",
      }),
    ).toBe("/auth");
  });

  it("requires selection instead of accepting an organization route parameter", () => {
    expect(
      resolveWebProductDestination({
        authenticated: true,
        organizationSelected: false,
        pathname: "/workspace",
        status: "organization-selection",
      }),
    ).toBe("/organizations");
  });

  it("preserves authenticated nested resource routes", () => {
    expect(
      resolveWebProductDestination({
        authenticated: true,
        organizationSelected: true,
        pathname: "/workspace/projects/project-id",
        status: "live",
      }),
    ).toBeNull();
  });
});
