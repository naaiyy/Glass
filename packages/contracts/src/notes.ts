import {
  OpenEditorDocumentParseError,
  parseOpenEditorDocument,
  type OpenEditorDocument,
} from "@openeditor/core";

import type { ArtifactId, IsoDateTime, OrganizationId, UserId } from "./ids.ts";
import { decodeId, decodeIsoDateTime } from "./ids.ts";
import { decodeFailure, decodeRecord, decodeSuccess, type DecodeResult } from "./validation.ts";

export const maxNoteContentBytes = 5 * 1024 * 1024;
/** Bounded JSON envelope overhead for UUID identity and durable save metadata fields. */
export const maxNoteContentEnvelopeBytes = maxNoteContentBytes + 1024;

export type LoadNoteContentRequest = Readonly<{
  noteId: ArtifactId;
  organizationId: OrganizationId;
}>;

export type NoteContentResponse = Readonly<{
  content: OpenEditorDocument;
  noteId: ArtifactId;
  organizationId: OrganizationId;
  savedAt: IsoDateTime;
  savedByUserId: UserId;
}>;

export type SaveNoteContentRequest = Readonly<{
  content: OpenEditorDocument;
  noteId: ArtifactId;
  organizationId: OrganizationId;
}>;

export type SaveNoteContentResponse = Readonly<{
  noteId: ArtifactId;
  organizationId: OrganizationId;
  savedAt: IsoDateTime;
  savedByUserId: UserId;
}>;

type NoteIdentity = Readonly<{
  noteId: ArtifactId;
  organizationId: OrganizationId;
}>;

const serializedByteLength = (value: unknown): number | null => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
};

const enforceOuterBound = <Value>(
  value: Value,
  path: string,
  maximumBytes = maxNoteContentBytes,
): DecodeResult<Value> => {
  const byteLength = serializedByteLength(value);
  if (byteLength === null) {
    return decodeFailure(path, "invalid_format", "Expected JSON-serializable note data.");
  }
  return byteLength <= maximumBytes
    ? decodeSuccess(value)
    : decodeFailure(path, "out_of_range", `Serialized note data exceeds ${maximumBytes} bytes.`);
};

export const decodeOpenEditorNoteContent = (
  input: unknown,
  path = "$.content",
): DecodeResult<OpenEditorDocument> => {
  const boundedInput = enforceOuterBound(input, path);
  if (!boundedInput.ok) return boundedInput;

  try {
    const normalized = parseOpenEditorDocument(boundedInput.value);
    return enforceOuterBound(normalized, path);
  } catch (error) {
    if (error instanceof OpenEditorDocumentParseError) {
      return {
        ok: false,
        issues: error.validation.issues.map((issue) => ({
          code: "invalid_format" as const,
          message: issue.message,
          path: issue.path === "$" ? path : `${path}${issue.path.slice(1)}`,
        })),
      };
    }
    return decodeFailure(path, "invalid_format", "Invalid OpenEditor document payload.");
  }
};

const decodeNoteIdentity = (
  input: Readonly<Record<string, unknown>>,
  path: string,
): DecodeResult<NoteIdentity> => {
  const noteId = decodeId<ArtifactId>(input.noteId, `${path}.noteId`);
  const organizationId = decodeId<OrganizationId>(input.organizationId, `${path}.organizationId`);
  const issues = [noteId, organizationId].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!noteId.ok || !organizationId.ok) {
    return decodeFailure(path, "invalid_type", "Invalid note identity.");
  }
  return decodeSuccess({ noteId: noteId.value, organizationId: organizationId.value });
};

const rejectUnknownKeys = (
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): DecodeResult<true> => {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  return unknownKey === undefined
    ? decodeSuccess(true)
    : decodeFailure(`${path}.${unknownKey}`, "unknown_variant", "Unknown note content field.");
};

const decodeSavedMetadata = (
  input: Readonly<Record<string, unknown>>,
  path: string,
): DecodeResult<Readonly<{ savedAt: IsoDateTime; savedByUserId: UserId }>> => {
  const savedAt = decodeIsoDateTime(input.savedAt, `${path}.savedAt`);
  const savedByUserId = decodeId<UserId>(input.savedByUserId, `${path}.savedByUserId`);
  const issues = [savedAt, savedByUserId].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!savedAt.ok || !savedByUserId.ok) {
    return decodeFailure(path, "invalid_type", "Invalid durable note save metadata.");
  }
  return decodeSuccess({ savedAt: savedAt.value, savedByUserId: savedByUserId.value });
};

export const decodeLoadNoteContentRequest = (
  input: unknown,
): DecodeResult<LoadNoteContentRequest> => {
  const record = decodeRecord(input, "$loadNoteContent");
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(record.value, ["noteId", "organizationId"], "$loadNoteContent");
  if (!keys.ok) return keys;
  return decodeNoteIdentity(record.value, "$loadNoteContent");
};

const decodeSaveEnvelope = (input: unknown, path: string): DecodeResult<SaveNoteContentRequest> => {
  const bounded = enforceOuterBound(input, path, maxNoteContentEnvelopeBytes);
  if (!bounded.ok) return bounded;
  const record = decodeRecord(bounded.value, path);
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(record.value, ["content", "noteId", "organizationId"], path);
  if (!keys.ok) return keys;
  const identity = decodeNoteIdentity(record.value, path);
  const content = decodeOpenEditorNoteContent(record.value.content, `${path}.content`);
  const issues = [identity, content].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!identity.ok || !content.ok) {
    return decodeFailure(path, "invalid_type", "Invalid note content envelope.");
  }
  const result = { ...identity.value, content: content.value };
  return enforceOuterBound(result, path, maxNoteContentEnvelopeBytes);
};

export const decodeNoteContentResponse = (input: unknown): DecodeResult<NoteContentResponse> => {
  const bounded = enforceOuterBound(input, "$noteContent", maxNoteContentEnvelopeBytes);
  if (!bounded.ok) return bounded;
  const record = decodeRecord(bounded.value, "$noteContent");
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(
    record.value,
    ["content", "noteId", "organizationId", "savedAt", "savedByUserId"],
    "$noteContent",
  );
  if (!keys.ok) return keys;
  const identity = decodeNoteIdentity(record.value, "$noteContent");
  const content = decodeOpenEditorNoteContent(record.value.content, "$noteContent.content");
  const saved = decodeSavedMetadata(record.value, "$noteContent");
  const issues = [identity, content, saved].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!identity.ok || !content.ok || !saved.ok) {
    return decodeFailure("$noteContent", "invalid_type", "Invalid note content response.");
  }
  return enforceOuterBound(
    { ...identity.value, ...saved.value, content: content.value },
    "$noteContent",
    maxNoteContentEnvelopeBytes,
  );
};

export const decodeSaveNoteContentRequest = (
  input: unknown,
): DecodeResult<SaveNoteContentRequest> => decodeSaveEnvelope(input, "$saveNoteContent");

export const decodeSaveNoteContentResponse = (
  input: unknown,
): DecodeResult<SaveNoteContentResponse> => {
  const record = decodeRecord(input, "$saveNoteContentResponse");
  if (!record.ok) return record;
  const keys = rejectUnknownKeys(
    record.value,
    ["noteId", "organizationId", "savedAt", "savedByUserId"],
    "$saveNoteContentResponse",
  );
  if (!keys.ok) return keys;
  const identity = decodeNoteIdentity(record.value, "$saveNoteContentResponse");
  const saved = decodeSavedMetadata(record.value, "$saveNoteContentResponse");
  const issues = [identity, saved].flatMap((result) => (result.ok ? [] : result.issues));
  if (issues.length > 0) return { ok: false, issues };
  if (!identity.ok || !saved.ok) {
    return decodeFailure("$saveNoteContentResponse", "invalid_type", "Invalid note save response.");
  }
  return decodeSuccess({ ...identity.value, ...saved.value });
};
