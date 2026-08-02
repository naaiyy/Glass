import type { ProductOperation } from "@glass/contracts/events";
import type { OrganizationRole } from "@glass/contracts/product";

export type AuthorizationDenial =
  | "last-owner-required"
  | "membership-required"
  | "owner-required"
  | "owner-role-protected";

export type AuthorizationDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: AuthorizationDenial }>;

const allow: AuthorizationDecision = { allowed: true };
const deny = (reason: AuthorizationDenial): AuthorizationDecision => ({ allowed: false, reason });

export type AuthorizationContext = Readonly<{
  actorRole: OrganizationRole | null;
  ownerCount?: number;
  targetMemberRole?: OrganizationRole;
}>;

export const authorizeProductOperation = (
  context: AuthorizationContext,
  operation: ProductOperation,
): AuthorizationDecision => {
  if (operation.kind === "organization.create") return allow;
  if (context.actorRole === null) return deny("membership-required");

  switch (operation.kind) {
    case "member.put": {
      if (operation.role === "owner" && context.actorRole !== "owner")
        return deny("owner-required");
      if (context.targetMemberRole === "owner" && context.actorRole !== "owner") {
        return deny("owner-role-protected");
      }
      if (
        context.targetMemberRole === "owner" &&
        operation.role !== "owner" &&
        (context.ownerCount === undefined || context.ownerCount <= 1)
      ) {
        return deny("last-owner-required");
      }
      return context.actorRole === "member" ? deny("owner-required") : allow;
    }
    case "member.remove": {
      if (context.targetMemberRole === "owner" && context.actorRole !== "owner") {
        return deny("owner-role-protected");
      }
      if (
        context.targetMemberRole === "owner" &&
        (context.ownerCount === undefined || context.ownerCount <= 1)
      ) {
        return deny("last-owner-required");
      }
      return context.actorRole === "member" ? deny("owner-required") : allow;
    }
    case "organization.update":
      return context.actorRole === "member" ? deny("owner-required") : allow;
    case "artifact.create":
    case "artifact.delete":
    case "message.create":
    case "message.delete":
    case "note.create":
    case "note.update":
    case "project.create":
    case "project.delete":
    case "project.update":
    case "thread.create":
    case "thread.delete":
    case "thread.update":
      return allow;
    default: {
      const unhandledOperation: never = operation;
      return unhandledOperation;
    }
  }
};
