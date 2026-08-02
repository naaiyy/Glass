import { describe, expect, it } from "vite-plus/test";

import {
  decodeListOrganizationsRequest,
  decodeOrganizationsPage,
  maxOrganizationsPageLimit,
} from "./organizations.ts";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const letteredId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-08-02T12:00:00.000Z";

const item = (organizationId: string) => ({
  organization: {
    id: organizationId,
    name: "Glass",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  membership: {
    organizationId,
    userId,
    role: "owner",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

describe("organization discovery contracts", () => {
  it("rejects non-canonical uppercase UUID cursors", () => {
    expect(decodeListOrganizationsRequest({ after: letteredId.toUpperCase(), limit: 50 }).ok).toBe(
      false,
    );
  });

  it("accepts bounded keyset requests", () => {
    expect(decodeListOrganizationsRequest({ after: null, limit: 50 })).toMatchObject({ ok: true });
    expect(
      decodeListOrganizationsRequest({ after: firstId, limit: maxOrganizationsPageLimit }),
    ).toMatchObject({
      ok: true,
    });
    expect(decodeListOrganizationsRequest({ after: null, limit: 101 })).toMatchObject({
      ok: false,
    });
  });

  it("validates scoped, ordered organization membership pages", () => {
    expect(
      decodeOrganizationsPage({ items: [item(firstId), item(secondId)], nextCursor: secondId }),
    ).toMatchObject({ ok: true });
    expect(
      decodeOrganizationsPage({ items: [item(secondId), item(firstId)], nextCursor: null }),
    ).toMatchObject({ ok: false });
    expect(
      decodeOrganizationsPage({
        items: [
          {
            ...item(firstId),
            membership: { ...item(firstId).membership, organizationId: secondId },
          },
        ],
        nextCursor: null,
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects unknown envelope fields and unrelated continuation cursors", () => {
    expect(decodeOrganizationsPage({ items: [], nextCursor: null, offset: 0 })).toMatchObject({
      ok: false,
    });
    expect(decodeOrganizationsPage({ items: [item(firstId)], nextCursor: secondId })).toMatchObject(
      {
        ok: false,
      },
    );
  });
});
