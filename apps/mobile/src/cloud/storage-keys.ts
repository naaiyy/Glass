import type { OrganizationId, UserId } from "@glass/contracts/ids";

export type MobileCloudScope = Readonly<{
  organizationId: OrganizationId;
  userId: UserId;
}>;

const prefix = "glass:mobile:product:v1";

export const activeOrganizationKey = (userId: UserId): string =>
  `${prefix}:user:${userId}:active-organization`;

export const organizationBootstrapKey = (userId: UserId): string =>
  `${prefix}:user:${userId}:organization-bootstrap`;

export const productCacheKey = (scope: MobileCloudScope): string =>
  `${prefix}:user:${scope.userId}:organization:${scope.organizationId}:cache`;

export const outboxKey = (scope: MobileCloudScope): string =>
  `${prefix}:user:${scope.userId}:organization:${scope.organizationId}:outbox`;
