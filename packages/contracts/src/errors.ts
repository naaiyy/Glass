export type BoundaryErrorCode =
  | "CONFLICT"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "EXECUTION_UNAVAILABLE"
  | "FORBIDDEN"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "VALIDATION_FAILED";

export type BoundaryError = Readonly<{
  code: BoundaryErrorCode;
  commandId?: CommandId;
  currentVersion?: number;
  message: string;
  retryable: boolean;
}>;
import type { CommandId } from "./ids.ts";
