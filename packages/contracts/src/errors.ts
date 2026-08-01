export type BoundaryErrorCode =
  | "EXECUTION_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "PRODUCT_UNAVAILABLE"
  | "UNAUTHENTICATED";

export type BoundaryError = Readonly<{
  code: BoundaryErrorCode;
  message: string;
  retryable: boolean;
}>;
