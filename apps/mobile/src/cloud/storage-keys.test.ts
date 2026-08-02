import type { OrganizationId, UserId } from "@glass/contracts/ids";
import { describe, expect, it } from "vite-plus/test";

import { outboxKey, productCacheKey } from "./storage-keys.ts";

const userA = "11111111-1111-4111-8111-111111111111" as UserId;
const userB = "22222222-2222-4222-8222-222222222222" as UserId;
const organizationA = "33333333-3333-4333-8333-333333333333" as OrganizationId;
const organizationB = "44444444-4444-4444-8444-444444444444" as OrganizationId;

describe("mobile product persistence keys", () => {
  it("isolates product caches by both user and organization", () => {
    const first = productCacheKey({ userId: userA, organizationId: organizationA });
    expect(first).toContain("product:v1");
    expect(productCacheKey({ userId: userB, organizationId: organizationA })).not.toBe(first);
    expect(productCacheKey({ userId: userA, organizationId: organizationB })).not.toBe(first);
  });

  it("keeps the durable outbox inside its authenticated scope", () => {
    const key = outboxKey({ userId: userA, organizationId: organizationA });
    expect(key).toContain(`user:${userA}`);
    expect(key).toContain(`organization:${organizationA}`);
    expect(key).toContain(":outbox");
  });
});
