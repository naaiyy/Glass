import type { BoundaryError } from "@glass/contracts/errors";

export type ProductConnectionState =
  | Readonly<{ status: "connecting" }>
  | Readonly<{ status: "online" }>
  | Readonly<{ error: BoundaryError; status: "offline" }>;

export type ExecutionConnectionState =
  | Readonly<{ status: "not-configured" }>
  | Readonly<{ environmentId: string; status: "connecting" }>
  | Readonly<{ environmentId: string; status: "online" }>
  | Readonly<{ environmentId: string; error: BoundaryError; status: "offline" }>;

export type GlassConnectionState = Readonly<{
  product: ProductConnectionState;
  execution: ExecutionConnectionState;
}>;

export const initialConnectionState = (): GlassConnectionState => ({
  product: { status: "connecting" },
  execution: { status: "not-configured" },
});
