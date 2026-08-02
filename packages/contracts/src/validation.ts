export type ValidationIssueCode =
  | "invalid_format"
  | "invalid_type"
  | "missing_field"
  | "out_of_range"
  | "unknown_variant";

export type ValidationIssue = Readonly<{
  code: ValidationIssueCode;
  message: string;
  path: string;
}>;

export type DecodeResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ issues: readonly ValidationIssue[]; ok: false }>;

export const decodeSuccess = <Value>(value: Value): DecodeResult<Value> => ({ ok: true, value });

export const decodeFailure = <Value = never>(
  path: string,
  code: ValidationIssueCode,
  message: string,
): DecodeResult<Value> => ({ ok: false, issues: [{ code, message, path }] });

export const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

export const hasOwn = <Key extends string>(
  input: Readonly<Record<string, unknown>>,
  key: Key,
): input is Readonly<Record<string, unknown>> & Readonly<Record<Key, unknown>> =>
  Object.hasOwn(input, key);

export const decodeString = (
  input: unknown,
  path: string,
  options: Readonly<{ maxLength?: number; minLength?: number }> = {},
): DecodeResult<string> => {
  if (typeof input !== "string") {
    return decodeFailure(path, "invalid_type", "Expected a string.");
  }
  const minLength = options.minLength ?? 0;
  if (
    input.length < minLength ||
    (options.maxLength !== undefined && input.length > options.maxLength)
  ) {
    return decodeFailure(path, "out_of_range", "String length is outside the accepted range.");
  }
  return decodeSuccess(input);
};

export const decodeInteger = (
  input: unknown,
  path: string,
  options: Readonly<{ max?: number; min?: number }> = {},
): DecodeResult<number> => {
  if (!Number.isSafeInteger(input)) {
    return decodeFailure(path, "invalid_type", "Expected a safe integer.");
  }
  const value = input as number;
  if (
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    return decodeFailure(path, "out_of_range", "Integer is outside the accepted range.");
  }
  return decodeSuccess(value);
};

export const decodeRecord = (
  input: unknown,
  path: string,
): DecodeResult<Readonly<Record<string, unknown>>> =>
  isRecord(input)
    ? decodeSuccess(input)
    : decodeFailure(path, "invalid_type", "Expected an object.");

export const required = (
  input: Readonly<Record<string, unknown>>,
  key: string,
  path = "$",
): DecodeResult<unknown> =>
  hasOwn(input, key)
    ? decodeSuccess(input[key])
    : decodeFailure(`${path}.${key}`, "missing_field", "Required field is missing.");

export const combine = <Value>(
  values: readonly DecodeResult<unknown>[],
  build: () => Value,
): DecodeResult<Value> => {
  const issues = values.flatMap((result) => (result.ok ? [] : result.issues));
  return issues.length > 0 ? { ok: false, issues } : decodeSuccess(build());
};
