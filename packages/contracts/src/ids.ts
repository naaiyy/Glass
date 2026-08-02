import { decodeFailure, decodeString, decodeSuccess, type DecodeResult } from "./validation.ts";

declare const idBrand: unique symbol;
type BrandedId<Name extends string> = string & Readonly<{ [idBrand]: Name }>;

export type ArtifactId = BrandedId<"ArtifactId">;
export type CommandId = BrandedId<"CommandId">;
export type EventId = BrandedId<"EventId">;
export type MessageId = BrandedId<"MessageId">;
export type OrganizationId = BrandedId<"OrganizationId">;
export type ProjectId = BrandedId<"ProjectId">;
export type ThreadId = BrandedId<"ThreadId">;
export type UserId = BrandedId<"UserId">;

export type IsoDateTime = string & Readonly<{ [idBrand]: "IsoDateTime" }>;
export type MessageOrdinal = string & Readonly<{ [idBrand]: "MessageOrdinal" }>;
export type SyncCursor = string & Readonly<{ [idBrand]: "SyncCursor" }>;

// IDs are stored as text and used as keyset cursors, so differently cased
// spellings must not compare or index as distinct identities.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const cursorPattern = /^(?:0|[1-9][0-9]*)$/u;
const positiveDecimalPattern = /^[1-9][0-9]*$/u;
const postgresBigintMaximum = 9_223_372_036_854_775_807n;

const isPostgresBigint = (value: string): boolean =>
  value.length <= 19 && BigInt(value) <= postgresBigintMaximum;

export const decodeId = <Id extends string>(input: unknown, path: string): DecodeResult<Id> => {
  const decoded = decodeString(input, path, { minLength: 36, maxLength: 36 });
  if (!decoded.ok) return decoded;
  return uuidPattern.test(decoded.value)
    ? decodeSuccess(decoded.value as Id)
    : decodeFailure(path, "invalid_format", "Expected a canonical UUID.");
};

export const decodeIsoDateTime = (input: unknown, path: string): DecodeResult<IsoDateTime> => {
  const decoded = decodeString(input, path, { minLength: 20, maxLength: 35 });
  if (!decoded.ok) return decoded;
  const timestamp = Date.parse(decoded.value);
  return Number.isNaN(timestamp) || !decoded.value.endsWith("Z")
    ? decodeFailure(path, "invalid_format", "Expected an ISO 8601 UTC timestamp.")
    : decodeSuccess(decoded.value as IsoDateTime);
};

export const decodeSyncCursor = (input: unknown, path: string): DecodeResult<SyncCursor> => {
  const decoded = decodeString(input, path, { minLength: 1, maxLength: 19 });
  if (!decoded.ok) return decoded;
  return cursorPattern.test(decoded.value) && isPostgresBigint(decoded.value)
    ? decodeSuccess(decoded.value as SyncCursor)
    : decodeFailure(
        path,
        "invalid_format",
        "Expected a non-negative decimal cursor within the durable database range.",
      );
};

export const decodeMessageOrdinal = (
  input: unknown,
  path: string,
): DecodeResult<MessageOrdinal> => {
  const decoded = decodeString(input, path, { minLength: 1, maxLength: 19 });
  if (!decoded.ok) return decoded;
  return positiveDecimalPattern.test(decoded.value) && isPostgresBigint(decoded.value)
    ? decodeSuccess(decoded.value as MessageOrdinal)
    : decodeFailure(
        path,
        "invalid_format",
        "Expected a positive decimal message ordinal within the durable database range.",
      );
};
