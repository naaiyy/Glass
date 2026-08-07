import type {
  ArtifactId,
  IsoDateTime,
  MessageId,
  MessageOrdinal,
  OrganizationId,
  ProjectId,
  ThreadId,
  UserId,
} from "./ids.ts";
import { decodeId, decodeIsoDateTime, decodeMessageOrdinal } from "./ids.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeString,
  decodeSuccess,
  hasOwn,
  type DecodeResult,
  type ValidationIssue,
} from "./validation.ts";

export type OrganizationRole = "admin" | "member" | "owner";
export type ProductEntityType =
  | "artifact"
  | "message"
  | "organization"
  | "organization-member"
  | "project"
  | "thread";

export type JsonValue = boolean | null | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;
export type ArtifactKind = "agent-output" | "note";

export const maxArtifactBodyBytes = 1_000_000 as const;
export const maxMessageBodyBytes = 1_000_000 as const;

export type Organization = Readonly<{
  createdAt: IsoDateTime;
  id: OrganizationId;
  name: string;
  updatedAt: IsoDateTime;
  version: number;
}>;

export type OrganizationMember = Readonly<{
  createdAt: IsoDateTime;
  organizationId: OrganizationId;
  role: OrganizationRole;
  updatedAt: IsoDateTime;
  userId: UserId;
  version: number;
}>;

export type Project = Readonly<{
  createdAt: IsoDateTime;
  id: ProjectId;
  name: string;
  organizationId: OrganizationId;
  updatedAt: IsoDateTime;
  version: number;
}>;

export type Thread = Readonly<{
  createdAt: IsoDateTime;
  id: ThreadId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  title: string | null;
  updatedAt: IsoDateTime;
  version: number;
}>;

export type Message = Readonly<{
  authorUserId: UserId;
  body: string;
  createdAt: IsoDateTime;
  id: MessageId;
  organizationId: OrganizationId;
  ordinal: MessageOrdinal;
  projectId: ProjectId;
  threadId: ThreadId;
  updatedAt: IsoDateTime;
  version: number;
}>;

type ArtifactBase = Readonly<{
  createdAt: IsoDateTime;
  id: ArtifactId;
  name: string;
  organizationId: OrganizationId;
  projectId: ProjectId;
  updatedAt: IsoDateTime;
  version: number;
}>;

export type AgentOutputArtifact = ArtifactBase &
  Readonly<{
    body: JsonValue;
    kind: "agent-output";
    threadId: ThreadId | null;
  }>;

export type NoteArtifact = ArtifactBase &
  Readonly<{
    icon: string | null;
    kind: "note";
  }>;

export type Artifact = AgentOutputArtifact | NoteArtifact;

export type ProductEntity =
  | Artifact
  | Message
  | Organization
  | OrganizationMember
  | Project
  | Thread;

export const isOrganizationRole = (input: unknown): input is OrganizationRole =>
  input === "admin" || input === "member" || input === "owner";

export const decodeJsonValue = (input: unknown, path = "$", depth = 0): DecodeResult<JsonValue> => {
  if (depth > 20) return decodeFailure(path, "out_of_range", "JSON nesting exceeds 20 levels.");
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return decodeSuccess(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? decodeSuccess(input)
      : decodeFailure(path, "invalid_format", "JSON numbers must be finite.");
  }
  if (Array.isArray(input)) {
    const decoded = input.map((value, index) =>
      decodeJsonValue(value, `${path}[${index}]`, depth + 1),
    );
    const issues = decoded.flatMap((result) => (result.ok ? [] : result.issues));
    return issues.length > 0
      ? { ok: false, issues }
      : decodeSuccess(decoded.map((result) => (result.ok ? result.value : null)));
  }
  if (typeof input === "object" && input !== null) {
    const output: Record<string, JsonValue> = {};
    const issues: ValidationIssue[] = [];
    for (const [key, value] of Object.entries(input)) {
      const decoded = decodeJsonValue(value, `${path}.${key}`, depth + 1);
      if (decoded.ok) output[key] = decoded.value;
      else issues.push(...decoded.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : decodeSuccess(output);
  }
  return decodeFailure(path, "invalid_type", "Expected a JSON value.");
};

export const decodeArtifactBody = (input: unknown, path = "$.body"): DecodeResult<JsonValue> => {
  const decoded = decodeJsonValue(input, path);
  if (!decoded.ok) return decoded;
  return new TextEncoder().encode(JSON.stringify(decoded.value)).byteLength <= maxArtifactBodyBytes
    ? decoded
    : decodeFailure(path, "out_of_range", `Artifact output exceeds ${maxArtifactBodyBytes} bytes.`);
};

export const decodeMessageBody = (input: unknown, path = "$.body"): DecodeResult<string> => {
  const decoded = decodeString(input, path, { minLength: 1, maxLength: maxMessageBodyBytes });
  if (!decoded.ok) return decoded;
  return new TextEncoder().encode(decoded.value).byteLength <= maxMessageBodyBytes
    ? decoded
    : decodeFailure(path, "out_of_range", `Message body exceeds ${maxMessageBodyBytes} bytes.`);
};

const decodeNullableString = (
  input: unknown,
  path: string,
  maxLength: number,
): DecodeResult<string | null> =>
  input === null ? decodeSuccess(null) : decodeString(input, path, { maxLength });

const decodeRole = (input: unknown, path: string): DecodeResult<OrganizationRole> =>
  isOrganizationRole(input)
    ? decodeSuccess(input)
    : decodeFailure(path, "unknown_variant", "Expected owner, admin, or member.");

type CommonRecord = Readonly<{
  createdAt: IsoDateTime;
  organizationId: OrganizationId;
  updatedAt: IsoDateTime;
  version: number;
}>;

const decodeCommon = (
  input: Readonly<Record<string, unknown>>,
  path: string,
): DecodeResult<CommonRecord> => {
  const organizationId = decodeId<OrganizationId>(input.organizationId, `${path}.organizationId`);
  const createdAt = decodeIsoDateTime(input.createdAt, `${path}.createdAt`);
  const updatedAt = decodeIsoDateTime(input.updatedAt, `${path}.updatedAt`);
  const version = decodeInteger(input.version, `${path}.version`, { min: 1 });
  const issues = [organizationId, createdAt, updatedAt, version].flatMap((r) =>
    r.ok ? [] : r.issues,
  );
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !createdAt.ok || !updatedAt.ok || !version.ok) {
    return decodeFailure(path, "invalid_type", "Invalid common entity fields.");
  }
  return decodeSuccess({
    organizationId: organizationId.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    version: version.value,
  });
};

export const decodeProductEntity = (
  entityType: ProductEntityType,
  input: unknown,
  path = "$entity",
): DecodeResult<ProductEntity> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const exactFields: Partial<Record<ProductEntityType, readonly string[]>> = {
    organization: ["createdAt", "id", "name", "updatedAt", "version"],
    "organization-member": [
      "createdAt",
      "organizationId",
      "role",
      "updatedAt",
      "userId",
      "version",
    ],
    project: ["createdAt", "id", "name", "organizationId", "updatedAt", "version"],
    thread: ["createdAt", "id", "organizationId", "projectId", "title", "updatedAt", "version"],
    message: [
      "authorUserId",
      "body",
      "createdAt",
      "id",
      "ordinal",
      "organizationId",
      "projectId",
      "threadId",
      "updatedAt",
      "version",
    ],
  };
  const allowedFields = exactFields[entityType];
  const unknownField =
    allowedFields === undefined
      ? undefined
      : Object.keys(record.value).find((key) => !allowedFields.includes(key));
  if (unknownField !== undefined) {
    return decodeFailure(
      `${path}.${unknownField}`,
      "unknown_variant",
      "Unknown product entity field.",
    );
  }
  if (entityType === "organization") {
    const id = decodeId<OrganizationId>(record.value.id, `${path}.id`);
    const name = decodeString(record.value.name, `${path}.name`, { minLength: 1, maxLength: 240 });
    const createdAt = decodeIsoDateTime(record.value.createdAt, `${path}.createdAt`);
    const updatedAt = decodeIsoDateTime(record.value.updatedAt, `${path}.updatedAt`);
    const version = decodeInteger(record.value.version, `${path}.version`, { min: 1 });
    const issues = [id, name, createdAt, updatedAt, version].flatMap((r) => (r.ok ? [] : r.issues));
    if (issues.length > 0) return { ok: false, issues };
    if (!id.ok || !name.ok || !createdAt.ok || !updatedAt.ok || !version.ok)
      return decodeFailure(path, "invalid_type", "Invalid organization.");
    return decodeSuccess({
      id: id.value,
      name: name.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      version: version.value,
    });
  }
  const common = decodeCommon(record.value, path);
  if (!common.ok) return common;
  const name = hasOwn(record.value, "name")
    ? decodeString(record.value.name, `${path}.name`, { minLength: 1, maxLength: 240 })
    : decodeFailure<string>(`${path}.name`, "missing_field", "Required field is missing.");

  if (entityType === "organization-member") {
    const userId = decodeId<UserId>(record.value.userId, `${path}.userId`);
    const role = decodeRole(record.value.role, `${path}.role`);
    if (!userId.ok || !role.ok)
      return {
        ok: false,
        issues: [...(!userId.ok ? userId.issues : []), ...(!role.ok ? role.issues : [])],
      };
    return decodeSuccess({ ...common.value, userId: userId.value, role: role.value });
  }
  const projectId =
    entityType === "project"
      ? decodeId<ProjectId>(record.value.id, `${path}.id`)
      : decodeId<ProjectId>(record.value.projectId, `${path}.projectId`);
  if (!projectId.ok) return projectId;
  if (entityType === "project") {
    if (!name.ok) return name;
    return decodeSuccess({
      ...common.value,
      id: projectId.value,
      name: name.value,
    });
  }
  if (entityType === "thread") {
    const id = decodeId<ThreadId>(record.value.id, `${path}.id`);
    const title = decodeNullableString(record.value.title, `${path}.title`, 240);
    if (!id.ok || !title.ok)
      return {
        ok: false,
        issues: [...(!id.ok ? id.issues : []), ...(!title.ok ? title.issues : [])],
      };
    return decodeSuccess({
      ...common.value,
      id: id.value,
      projectId: projectId.value,
      title: title.value,
    });
  }
  if (entityType === "message") {
    const id = decodeId<MessageId>(record.value.id, `${path}.id`);
    const threadId = decodeId<ThreadId>(record.value.threadId, `${path}.threadId`);
    const authorUserId = decodeId<UserId>(record.value.authorUserId, `${path}.authorUserId`);
    const body = decodeMessageBody(record.value.body, `${path}.body`);
    const ordinal = decodeMessageOrdinal(record.value.ordinal, `${path}.ordinal`);
    const failures = [id, threadId, authorUserId, body, ordinal].flatMap((r) =>
      r.ok ? [] : r.issues,
    );
    if (failures.length > 0) return { ok: false, issues: failures };
    if (!id.ok || !threadId.ok || !authorUserId.ok || !body.ok || !ordinal.ok)
      return decodeFailure(path, "invalid_type", "Invalid message.");
    return decodeSuccess({
      ...common.value,
      id: id.value,
      projectId: projectId.value,
      threadId: threadId.value,
      authorUserId: authorUserId.value,
      body: body.value,
      ordinal: ordinal.value,
    });
  }
  const id = decodeId<ArtifactId>(record.value.id, `${path}.id`);
  if (!id.ok || !name.ok) {
    return {
      ok: false,
      issues: [...(!id.ok ? id.issues : []), ...(!name.ok ? name.issues : [])],
    };
  }
  const base = {
    ...common.value,
    id: id.value,
    projectId: projectId.value,
    name: name.value,
  };
  if (record.value.kind === "note") {
    const allowedKeys = new Set([
      "createdAt",
      "icon",
      "id",
      "kind",
      "name",
      "organizationId",
      "projectId",
      "updatedAt",
      "version",
    ]);
    const unknownKey = Object.keys(record.value).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
      return decodeFailure(
        `${path}.${unknownKey}`,
        "unknown_variant",
        "Note artifacts contain metadata only.",
      );
    }
    const icon = decodeNullableString(record.value.icon, `${path}.icon`, 64);
    return icon.ok ? decodeSuccess({ ...base, kind: record.value.kind, icon: icon.value }) : icon;
  }
  if (record.value.kind === "agent-output") {
    const allowedKeys = new Set([
      "body",
      "createdAt",
      "id",
      "kind",
      "name",
      "organizationId",
      "projectId",
      "threadId",
      "updatedAt",
      "version",
    ]);
    const unknownKey = Object.keys(record.value).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
      return decodeFailure(
        `${path}.${unknownKey}`,
        "unknown_variant",
        "Unknown agent-output artifact field.",
      );
    }
    const body = decodeArtifactBody(record.value.body, `${path}.body`);
    const threadId =
      record.value.threadId === null
        ? decodeSuccess<ThreadId | null>(null)
        : decodeId<ThreadId>(record.value.threadId, `${path}.threadId`);
    const failures = [body, threadId].flatMap((result) => (result.ok ? [] : result.issues));
    if (failures.length > 0) return { ok: false, issues: failures };
    if (!body.ok || !threadId.ok) {
      return decodeFailure(path, "invalid_type", "Invalid agent-output artifact.");
    }
    return decodeSuccess({
      ...base,
      kind: record.value.kind,
      body: body.value,
      threadId: threadId.value,
    });
  }
  return decodeFailure(
    `${path}.kind`,
    "unknown_variant",
    "Expected agent-output or note artifact kind.",
  );
};
