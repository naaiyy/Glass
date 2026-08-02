import type { ProductOperation } from "@glass/contracts/events";
import type { ArtifactId, ProjectId, UserId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";

import { authorizeProductOperation } from "./authorization.ts";

const userId = "44444444-4444-4444-8444-444444444444" as UserId;
const projectId = "33333333-3333-4333-8333-333333333333" as ProjectId;
const artifactId = "55555555-5555-4555-8555-555555555555" as ArtifactId;

describe("organization authorization", () => {
  it("allows an authenticated member to mutate Glass-owned project state", () => {
    const operation = {
      kind: "project.update",
      projectId,
      expectedVersion: 1,
      name: "Updated project",
      description: null,
    } satisfies ProductOperation;

    expect(authorizeProductOperation({ actorRole: "member" }, operation)).toEqual({
      allowed: true,
    });
  });

  it("requires membership for every protected operation", () => {
    const operation = {
      kind: "project.delete",
      projectId,
      expectedVersion: 1,
    } satisfies ProductOperation;

    expect(authorizeProductOperation({ actorRole: null }, operation)).toEqual({
      allowed: false,
      reason: "membership-required",
    });
  });

  it("authorizes note metadata updates without treating content as a product operation", () => {
    const operation = {
      artifactId,
      expectedVersion: 2,
      icon: "📝",
      kind: "note.update",
      name: "Architecture",
    } satisfies ProductOperation;

    expect(authorizeProductOperation({ actorRole: "member" }, operation)).toEqual({
      allowed: true,
    });
  });

  it("prevents a member from managing organization membership", () => {
    expect(
      authorizeProductOperation(
        { actorRole: "member" },
        { kind: "member.put", role: "member", userId, expectedVersion: null },
      ),
    ).toEqual({ allowed: false, reason: "owner-required" });
  });

  it("protects owners from administration by non-owners", () => {
    expect(
      authorizeProductOperation(
        { actorRole: "admin", targetMemberRole: "owner" },
        { kind: "member.remove", userId, expectedVersion: 1 },
      ),
    ).toEqual({ allowed: false, reason: "owner-role-protected" });
  });

  it("preserves at least one organization owner", () => {
    expect(
      authorizeProductOperation(
        { actorRole: "owner", ownerCount: 1, targetMemberRole: "owner" },
        { kind: "member.remove", userId, expectedVersion: 1 },
      ),
    ).toEqual({ allowed: false, reason: "last-owner-required" });
  });
});
