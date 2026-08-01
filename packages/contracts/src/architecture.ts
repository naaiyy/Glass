export const glassProtocolVersion = 1 as const;

export type GlassSurface = "web" | "desktop" | "mobile";

export type DesktopHostDescriptor = Readonly<{
  executionConnection: "optional";
  platform: string;
}>;

export type ProductAuthorityDescriptor = Readonly<{
  kind: "glass-cloud";
  protocolVersion: typeof glassProtocolVersion;
  status: "foundation";
}>;

export type ExecutionCapability =
  | "browser-automation"
  | "filesystem"
  | "git"
  | "processes"
  | "terminals"
  | "workspace-checkpoints";

export type ExecutionNodeDescriptor = Readonly<{
  kind: "execution-node";
  protocolVersion: typeof glassProtocolVersion;
  capabilities: readonly ExecutionCapability[];
  status: "foundation";
}>;

export type HealthDescriptor = Readonly<{
  service: "glass-api";
  status: "ok";
  architecture: ProductAuthorityDescriptor;
}>;
