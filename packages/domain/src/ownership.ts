import type { GlassSurface } from "@glass/contracts/architecture";

export type RuntimeOwner = "cloud" | "device" | "execution-environment";

export type RuntimeOwnership = Readonly<{
  owner: RuntimeOwner;
  resources: readonly string[];
}>;

export const ownershipByRuntime = {
  cloud: [
    "users-and-sessions",
    "organizations",
    "projects-and-artifacts",
    "threads-and-messages",
    "shared-documents",
    "uploads-and-notifications",
    "environment-registry-and-pairing",
    "durable-execution-metadata-and-results",
  ],
  device: ["ui-cache", "unsynced-drafts-and-outbox", "local-shell-and-layout"],
  "execution-environment": [
    "workspace-files-and-repositories",
    "terminals-and-processes",
    "provider-cli-credentials-and-processes",
    "local-execution-state",
    "workspace-checkpoints",
  ],
} as const satisfies Record<RuntimeOwner, readonly string[]>;

export const supportsProductWithoutExecution = (_surface: GlassSurface): true => true;
