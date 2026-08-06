export type BoundaryErrorCode =
  | "CONFLICT"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "EXECUTION_UNAVAILABLE"
  | "EXECUTION_CANCELLED"
  | "EXECUTION_FAILED"
  | "FORBIDDEN"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "TIMEOUT"
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
