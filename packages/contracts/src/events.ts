import type {
  ArtifactId,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  OrganizationId,
  ProjectId,
  SyncCursor,
  ThreadId,
  UserId,
} from "./ids.ts";
import { decodeId, decodeIsoDateTime, decodeSyncCursor } from "./ids.ts";
import type { JsonValue, OrganizationRole, ProductEntityType } from "./product.ts";
import {
  decodeArtifactBody,
  decodeMessageBody,
  decodeProductEntity,
  isOrganizationRole,
  type ProductEntity,
} from "./product.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeString,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export type ProductOperation =
  | Readonly<{ kind: "organization.create"; name: string }>
  | Readonly<{ expectedVersion: number; kind: "organization.update"; name: string }>
  | Readonly<{
      expectedVersion: number | null;
      kind: "member.put";
      role: OrganizationRole;
      userId: UserId;
    }>
  | Readonly<{ expectedVersion: number; kind: "member.remove"; userId: UserId }>
  | Readonly<{
      kind: "project.create";
      name: string;
      projectId: ProjectId;
    }>
  | Readonly<{
      expectedVersion: number;
      kind: "project.update";
      name: string;
      projectId: ProjectId;
    }>
  | Readonly<{ expectedVersion: number; kind: "project.delete"; projectId: ProjectId }>
  | Readonly<{
      kind: "thread.create";
      projectId: ProjectId;
      threadId: ThreadId;
      title: string | null;
    }>
  | Readonly<{
      expectedVersion: number;
      kind: "thread.update";
      threadId: ThreadId;
      title: string | null;
    }>
  | Readonly<{ expectedVersion: number; kind: "thread.delete"; threadId: ThreadId }>
  | Readonly<{
      body: string;
      kind: "message.create";
      messageId: MessageId;
      projectId: ProjectId;
      threadId: ThreadId;
    }>
  | Readonly<{ expectedVersion: number; kind: "message.delete"; messageId: MessageId }>
  | Readonly<{
      artifactId: ArtifactId;
      body: JsonValue;
      kind: "artifact.create";
      name: string;
      projectId: ProjectId;
      threadId: ThreadId | null;
      artifactKind: "agent-output";
    }>
  | Readonly<{
      artifactId: ArtifactId;
      icon: string | null;
      kind: "note.create";
      name: string;
      projectId: ProjectId;
    }>
  | Readonly<{
      artifactId: ArtifactId;
      expectedVersion: number;
      icon: string | null;
      kind: "note.update";
      name: string;
    }>
  | Readonly<{ artifactId: ArtifactId; expectedVersion: number; kind: "artifact.delete" }>;

export type ProductMutationEnvelope = Readonly<{
  commandId: CommandId;
  operation: ProductOperation;
  organizationId: OrganizationId;
}>;

export type ProductMutation = ProductMutationEnvelope;

export type ProductEventAction = "created" | "deleted" | "updated";

export type ProductEvent = Readonly<{
  action: ProductEventAction;
  actorUserId: UserId;
  aggregateId: string;
  aggregateType: ProductEntityType;
  aggregateVersion: number;
  commandId: CommandId;
  cursor: SyncCursor;
  entity: ProductEntity | null;
  eventId: EventId;
  occurredAt: IsoDateTime;
  organizationId: OrganizationId;
}>;

const decodeNullableString = (
  input: unknown,
  path: string,
  maxLength: number,
): DecodeResult<string | null> =>
  input === null ? decodeSuccess(null) : decodeString(input, path, { maxLength });

const decodeExpectedVersion = (input: unknown, path: string): DecodeResult<number> =>
  decodeInteger(input, path, { min: 1 });

const issuesOf = (results: readonly DecodeResult<unknown>[]) =>
  results.flatMap((result) => (result.ok ? [] : result.issues));

export const decodeProductOperation = (
  input: unknown,
  path = "$.operation",
): DecodeResult<ProductOperation> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const kind = decodeString(record.value.kind, `${path}.kind`, { minLength: 1, maxLength: 64 });
  if (!kind.ok) return kind;
  const operationFields: Readonly<Record<string, readonly string[]>> = {
    "organization.create": ["kind", "name"],
    "organization.update": ["expectedVersion", "kind", "name"],
    "member.put": ["expectedVersion", "kind", "role", "userId"],
    "member.remove": ["expectedVersion", "kind", "userId"],
    "project.create": ["kind", "name", "projectId"],
    "project.update": ["expectedVersion", "kind", "name", "projectId"],
    "project.delete": ["expectedVersion", "kind", "projectId"],
    "thread.create": ["kind", "projectId", "threadId", "title"],
    "thread.update": ["expectedVersion", "kind", "threadId", "title"],
    "thread.delete": ["expectedVersion", "kind", "threadId"],
    "message.create": ["body", "kind", "messageId", "projectId", "threadId"],
    "message.delete": ["expectedVersion", "kind", "messageId"],
    "artifact.create": [
      "artifactId",
      "artifactKind",
      "body",
      "kind",
      "name",
      "projectId",
      "threadId",
    ],
    "note.create": ["artifactId", "icon", "kind", "name", "projectId"],
    "note.update": ["artifactId", "expectedVersion", "icon", "kind", "name"],
    "artifact.delete": ["artifactId", "expectedVersion", "kind"],
  };
  const allowedFields = operationFields[kind.value];
  const unknownField =
    allowedFields === undefined
      ? undefined
      : Object.keys(record.value).find((key) => !allowedFields.includes(key));
  if (unknownField !== undefined) {
    return decodeFailure(
      `${path}.${unknownField}`,
      "unknown_variant",
      "Unknown product operation field.",
    );
  }
  const name = () =>
    decodeString(record.value.name, `${path}.name`, { minLength: 1, maxLength: 240 });
  const expected = () =>
    decodeExpectedVersion(record.value.expectedVersion, `${path}.expectedVersion`);
  const projectId = () => decodeId<ProjectId>(record.value.projectId, `${path}.projectId`);

  if (kind.value === "organization.create") {
    const n = name();
    return n.ok ? decodeSuccess({ kind: kind.value, name: n.value }) : n;
  }
  if (kind.value === "organization.update") {
    const n = name();
    const version = expected();
    const issues = issuesOf([n, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (n.ok && version.ok)
      return decodeSuccess({ kind: kind.value, name: n.value, expectedVersion: version.value });
  }
  if (kind.value === "member.put" || kind.value === "member.remove") {
    const userId = decodeId<UserId>(record.value.userId, `${path}.userId`);
    const version =
      kind.value === "member.put" && record.value.expectedVersion === null
        ? decodeSuccess<number | null>(null)
        : decodeExpectedVersion(record.value.expectedVersion, `${path}.expectedVersion`);
    const issues = issuesOf([userId, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (!userId.ok || !version.ok) {
      return decodeFailure(path, "invalid_type", "Invalid membership operation.");
    }
    if (kind.value === "member.remove") {
      if (version.value === null) {
        return decodeFailure(
          `${path}.expectedVersion`,
          "invalid_type",
          "Member removal requires a numeric expected version.",
        );
      }
      return decodeSuccess({
        kind: kind.value,
        userId: userId.value,
        expectedVersion: version.value,
      });
    }
    if (!isOrganizationRole(record.value.role))
      return decodeFailure(`${path}.role`, "unknown_variant", "Expected owner, admin, or member.");
    return decodeSuccess({
      kind: kind.value,
      userId: userId.value,
      role: record.value.role,
      expectedVersion: version.value,
    });
  }
  if (
    kind.value === "project.create" ||
    kind.value === "project.update" ||
    kind.value === "project.delete"
  ) {
    const id = projectId();
    if (!id.ok) return id;
    if (kind.value === "project.delete") {
      const version = expected();
      return version.ok
        ? decodeSuccess({ kind: kind.value, projectId: id.value, expectedVersion: version.value })
        : version;
    }
    const n = name();
    const version = kind.value === "project.update" ? expected() : decodeSuccess(1);
    const issues = issuesOf([n, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (n.ok && version.ok) {
      return kind.value === "project.create"
        ? decodeSuccess({
            kind: kind.value,
            projectId: id.value,
            name: n.value,
          })
        : decodeSuccess({
            kind: "project.update",
            projectId: id.value,
            name: n.value,
            expectedVersion: version.value,
          });
    }
  }
  if (
    kind.value === "thread.create" ||
    kind.value === "thread.update" ||
    kind.value === "thread.delete"
  ) {
    const threadId = decodeId<ThreadId>(record.value.threadId, `${path}.threadId`);
    if (!threadId.ok) return threadId;
    if (kind.value === "thread.delete") {
      const version = expected();
      return version.ok
        ? decodeSuccess({
            kind: kind.value,
            threadId: threadId.value,
            expectedVersion: version.value,
          })
        : version;
    }
    const title = decodeNullableString(record.value.title, `${path}.title`, 240);
    if (!title.ok) return title;
    if (kind.value === "thread.create") {
      const project = projectId();
      return project.ok
        ? decodeSuccess({
            kind: kind.value,
            threadId: threadId.value,
            projectId: project.value,
            title: title.value,
          })
        : project;
    }
    const version = expected();
    return version.ok
      ? decodeSuccess({
          kind: "thread.update",
          threadId: threadId.value,
          title: title.value,
          expectedVersion: version.value,
        })
      : version;
  }
  if (kind.value === "message.create") {
    const messageId = decodeId<MessageId>(record.value.messageId, `${path}.messageId`);
    const project = projectId();
    const threadId = decodeId<ThreadId>(record.value.threadId, `${path}.threadId`);
    const body = decodeMessageBody(record.value.body, `${path}.body`);
    const issues = issuesOf([messageId, project, threadId, body]);
    if (issues.length > 0) return { ok: false, issues };
    if (messageId.ok && project.ok && threadId.ok && body.ok)
      return decodeSuccess({
        kind: kind.value,
        messageId: messageId.value,
        projectId: project.value,
        threadId: threadId.value,
        body: body.value,
      });
  }
  if (kind.value === "message.delete") {
    const messageId = decodeId<MessageId>(record.value.messageId, `${path}.messageId`);
    const version = expected();
    const issues = issuesOf([messageId, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (messageId.ok && version.ok)
      return decodeSuccess({
        kind: kind.value,
        messageId: messageId.value,
        expectedVersion: version.value,
      });
  }
  if (kind.value === "artifact.create") {
    const artifactId = decodeId<ArtifactId>(record.value.artifactId, `${path}.artifactId`);
    const project = projectId();
    const n = name();
    const artifactKind =
      record.value.artifactKind === "agent-output"
        ? decodeSuccess<"agent-output">(record.value.artifactKind)
        : decodeFailure<"agent-output">(
            `${path}.artifactKind`,
            "unknown_variant",
            "Expected the Glass-owned agent-output artifact kind.",
          );
    const body = decodeArtifactBody(record.value.body, `${path}.body`);
    const threadId =
      record.value.threadId === null
        ? decodeSuccess<ThreadId | null>(null)
        : decodeId<ThreadId>(record.value.threadId, `${path}.threadId`);
    const issues = issuesOf([artifactId, project, n, artifactKind, body, threadId]);
    if (issues.length > 0) return { ok: false, issues };
    if (artifactId.ok && project.ok && n.ok && artifactKind.ok && body.ok && threadId.ok)
      return decodeSuccess({
        kind: kind.value,
        artifactId: artifactId.value,
        projectId: project.value,
        name: n.value,
        artifactKind: artifactKind.value,
        body: body.value,
        threadId: threadId.value,
      });
  }
  if (kind.value === "note.create" || kind.value === "note.update") {
    const artifactId = decodeId<ArtifactId>(record.value.artifactId, `${path}.artifactId`);
    const n = name();
    const icon = decodeNullableString(record.value.icon, `${path}.icon`, 64);
    const project =
      kind.value === "note.create" ? projectId() : decodeSuccess<ProjectId | null>(null);
    const version = kind.value === "note.update" ? expected() : decodeSuccess(1);
    const issues = issuesOf([artifactId, n, icon, project, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (artifactId.ok && n.ok && icon.ok && project.ok && version.ok) {
      return kind.value === "note.create" && project.value !== null
        ? decodeSuccess({
            kind: kind.value,
            artifactId: artifactId.value,
            projectId: project.value,
            name: n.value,
            icon: icon.value,
          })
        : decodeSuccess({
            kind: "note.update",
            artifactId: artifactId.value,
            expectedVersion: version.value,
            name: n.value,
            icon: icon.value,
          });
    }
  }
  if (kind.value === "artifact.delete") {
    const artifactId = decodeId<ArtifactId>(record.value.artifactId, `${path}.artifactId`);
    const version = expected();
    const issues = issuesOf([artifactId, version]);
    if (issues.length > 0) return { ok: false, issues };
    if (artifactId.ok && version.ok)
      return decodeSuccess({
        kind: kind.value,
        artifactId: artifactId.value,
        expectedVersion: version.value,
      });
  }
  return decodeFailure(`${path}.kind`, "unknown_variant", "Unknown product operation kind.");
};

export const decodeProductMutation = (
  input: unknown,
  path = "$mutation",
): DecodeResult<ProductMutationEnvelope> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => key !== "commandId" && key !== "operation" && key !== "organizationId",
  );
  if (unknownKey !== undefined) {
    return decodeFailure(`${path}.${unknownKey}`, "unknown_variant", "Unknown mutation field.");
  }
  const commandId = decodeId<CommandId>(record.value.commandId, `${path}.commandId`);
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    `${path}.organizationId`,
  );
  const operation = decodeProductOperation(record.value.operation, `${path}.operation`);
  const issues = issuesOf([commandId, organizationId, operation]);
  if (issues.length > 0) return { ok: false, issues };
  if (!commandId.ok || !organizationId.ok || !operation.ok)
    return decodeFailure(path, "invalid_type", "Invalid mutation.");
  return decodeSuccess({
    commandId: commandId.value,
    organizationId: organizationId.value,
    operation: operation.value,
  });
};

export const decodeProductEvent = (input: unknown, path = "$event"): DecodeResult<ProductEvent> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const eventFields = new Set([
    "action",
    "actorUserId",
    "aggregateId",
    "aggregateType",
    "aggregateVersion",
    "commandId",
    "cursor",
    "entity",
    "eventId",
    "occurredAt",
    "organizationId",
  ]);
  const unknownKey = Object.keys(record.value).find((key) => !eventFields.has(key));
  if (unknownKey !== undefined) {
    return decodeFailure(
      `${path}.${unknownKey}`,
      "unknown_variant",
      "Unknown product event field.",
    );
  }
  const eventId = decodeId<EventId>(record.value.eventId, `${path}.eventId`);
  const commandId = decodeId<CommandId>(record.value.commandId, `${path}.commandId`);
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    `${path}.organizationId`,
  );
  const actorUserId = decodeId<UserId>(record.value.actorUserId, `${path}.actorUserId`);
  const cursor = decodeSyncCursor(record.value.cursor, `${path}.cursor`);
  const occurredAt = decodeIsoDateTime(record.value.occurredAt, `${path}.occurredAt`);
  const aggregateVersion = decodeInteger(
    record.value.aggregateVersion,
    `${path}.aggregateVersion`,
    { min: 1 },
  );
  const aggregateId = decodeString(record.value.aggregateId, `${path}.aggregateId`, {
    minLength: 1,
    maxLength: 128,
  });
  const validTypes: readonly ProductEntityType[] = [
    "artifact",
    "message",
    "organization",
    "organization-member",
    "project",
    "thread",
  ];
  const aggregateType = validTypes.find((type) => type === record.value.aggregateType);
  const action =
    record.value.action === "created" ||
    record.value.action === "updated" ||
    record.value.action === "deleted"
      ? record.value.action
      : undefined;
  if (aggregateType === undefined)
    return decodeFailure(`${path}.aggregateType`, "unknown_variant", "Unknown aggregate type.");
  if (action === undefined)
    return decodeFailure(`${path}.action`, "unknown_variant", "Unknown event action.");
  const entity =
    record.value.entity === null
      ? decodeSuccess<ProductEntity | null>(null)
      : decodeProductEntity(aggregateType, record.value.entity, `${path}.entity`);
  const issues = issuesOf([
    eventId,
    commandId,
    organizationId,
    actorUserId,
    cursor,
    occurredAt,
    aggregateVersion,
    aggregateId,
    entity,
  ]);
  if (issues.length > 0) return { ok: false, issues };
  if (
    !eventId.ok ||
    !commandId.ok ||
    !organizationId.ok ||
    !actorUserId.ok ||
    !cursor.ok ||
    !occurredAt.ok ||
    !aggregateVersion.ok ||
    !aggregateId.ok ||
    !entity.ok
  )
    return decodeFailure(path, "invalid_type", "Invalid event.");
  if ((action === "deleted") !== (entity.value === null)) {
    return decodeFailure(
      `${path}.entity`,
      "invalid_format",
      "Deleted events require a null tombstone; created and updated events require an entity.",
    );
  }
  if (entity.value !== null) {
    const entityOrganizationId =
      "organizationId" in entity.value ? entity.value.organizationId : entity.value.id;
    const entityId = "id" in entity.value ? entity.value.id : entity.value.userId;
    if (
      entityOrganizationId !== organizationId.value ||
      entityId !== aggregateId.value ||
      entity.value.version !== aggregateVersion.value
    ) {
      return decodeFailure(
        `${path}.entity`,
        "invalid_format",
        "Event entities must match the event organization, aggregate identity, and version.",
      );
    }
  }
  return decodeSuccess({
    eventId: eventId.value,
    commandId: commandId.value,
    organizationId: organizationId.value,
    actorUserId: actorUserId.value,
    cursor: cursor.value,
    occurredAt: occurredAt.value,
    aggregateVersion: aggregateVersion.value,
    aggregateId: aggregateId.value,
    aggregateType,
    action,
    entity: entity.value,
  });
};
