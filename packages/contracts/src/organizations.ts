import type { OrganizationId } from "./ids.ts";
import { decodeId } from "./ids.ts";
import type { Organization, OrganizationMember } from "./product.ts";
import { decodeProductEntity } from "./product.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export const defaultOrganizationsPageLimit = 50 as const;
export const maxOrganizationsPageLimit = 100 as const;

export type ListOrganizationsRequest = Readonly<{
  after: OrganizationId | null;
  limit: number;
}>;

export type OrganizationMembershipItem = Readonly<{
  membership: OrganizationMember;
  organization: Organization;
}>;

export type OrganizationsPage = Readonly<{
  items: readonly OrganizationMembershipItem[];
  nextCursor: OrganizationId | null;
}>;

const rejectUnknownKeys = (
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): DecodeResult<true> => {
  const keys = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !keys.has(key));
  return unknown === undefined
    ? decodeSuccess(true)
    : decodeFailure(`${path}.${unknown}`, "unknown_variant", "Unknown organization page field.");
};

export const decodeListOrganizationsRequest = (
  input: unknown,
): DecodeResult<ListOrganizationsRequest> => {
  const record = decodeRecord(input, "$listOrganizations");
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(record.value, ["after", "limit"], "$listOrganizations");
  if (!keys.ok) return keys;
  const after =
    record.value.after === null
      ? decodeSuccess<OrganizationId | null>(null)
      : decodeId<OrganizationId>(record.value.after, "$listOrganizations.after");
  const limit = decodeInteger(record.value.limit, "$listOrganizations.limit", {
    min: 1,
    max: maxOrganizationsPageLimit,
  });
  const issues = [after, limit].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!after.ok || !limit.ok) {
    return decodeFailure(
      "$listOrganizations",
      "invalid_type",
      "Invalid organization page request.",
    );
  }
  return decodeSuccess({ after: after.value, limit: limit.value });
};

const decodeItem = (input: unknown, index: number): DecodeResult<OrganizationMembershipItem> => {
  const path = `$organizationsPage.items[${index}]`;
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(record.value, ["membership", "organization"], path);
  if (!keys.ok) return keys;
  const organization = decodeProductEntity(
    "organization",
    record.value.organization,
    `${path}.organization`,
  );
  const membership = decodeProductEntity(
    "organization-member",
    record.value.membership,
    `${path}.membership`,
  );
  const issues = [organization, membership].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!organization.ok || !membership.ok) {
    return decodeFailure(path, "invalid_type", "Invalid organization membership item.");
  }
  const organizationValue = organization.value as Organization;
  const membershipValue = membership.value as OrganizationMember;
  if (organizationValue.id !== membershipValue.organizationId) {
    return decodeFailure(
      path,
      "invalid_format",
      "Membership scope does not match its organization.",
    );
  }
  return decodeSuccess({
    organization: organizationValue,
    membership: membershipValue,
  });
};

export const decodeOrganizationsPage = (input: unknown): DecodeResult<OrganizationsPage> => {
  const record = decodeRecord(input, "$organizationsPage");
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(record.value, ["items", "nextCursor"], "$organizationsPage");
  if (!keys.ok) return keys;
  if (!Array.isArray(record.value.items)) {
    return decodeFailure("$organizationsPage.items", "invalid_type", "Expected an array.");
  }
  if (record.value.items.length > maxOrganizationsPageLimit) {
    return decodeFailure(
      "$organizationsPage.items",
      "out_of_range",
      `An organization page contains at most ${maxOrganizationsPageLimit} items.`,
    );
  }
  const items = record.value.items.map(decodeItem);
  const nextCursor =
    record.value.nextCursor === null
      ? decodeSuccess<OrganizationId | null>(null)
      : decodeId<OrganizationId>(record.value.nextCursor, "$organizationsPage.nextCursor");
  const issues = [...items, nextCursor].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!nextCursor.ok) {
    return decodeFailure("$organizationsPage", "invalid_type", "Invalid organization page.");
  }
  const values: OrganizationMembershipItem[] = [];
  for (const item of items) {
    if (!item.ok) return item;
    values.push(item.value);
  }
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.organization.id >= values[index]!.organization.id) {
      return decodeFailure(
        "$organizationsPage.items",
        "invalid_format",
        "Organization pages must be strictly ordered by organization ID.",
      );
    }
  }
  if (nextCursor.value !== null && nextCursor.value !== values.at(-1)?.organization.id) {
    return decodeFailure(
      "$organizationsPage.nextCursor",
      "invalid_format",
      "A continuation cursor must identify the final organization in the page.",
    );
  }
  return decodeSuccess({ items: values, nextCursor: nextCursor.value });
};
