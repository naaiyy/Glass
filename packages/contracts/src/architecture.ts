export const glassProtocolVersion = 1 as const;

export type GlassSurface = "web" | "desktop" | "mobile";

export type DesktopProductRequest = Readonly<{
  body: string | null;
  method: "GET" | "POST" | "PUT";
  path: string;
}>;

export type DesktopProductResponse = Readonly<{
  body: string;
  contentType: string;
  status: number;
}>;

export type DesktopHostDescriptor = Readonly<{
  executionConnection: "optional";
  platform: string;
  productCloudOrigin: string;
  requestProduct: (request: DesktopProductRequest) => Promise<DesktopProductResponse>;
}>;

export type ProductAuthorityDescriptor = Readonly<{
  kind: "glass-cloud";
  protocolVersion: typeof glassProtocolVersion;
  status: "durable-product-core" | "foundation";
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
