import type { CommandId, IsoDateTime, MessageOrdinal, OrganizationId, SyncCursor } from "./ids.ts";
import { decodeId, decodeIsoDateTime, decodeMessageOrdinal, decodeSyncCursor } from "./ids.ts";
import {
  decodeProductEvent,
  decodeProductMutation,
  type ProductEvent,
  type ProductMutation,
} from "./events.ts";
import {
  decodeProductEntity,
  type Artifact,
  type Message,
  type Organization,
  type OrganizationMember,
  type ProductEntity,
  type ProductEntityType,
  type Project,
  type Thread,
} from "./product.ts";
import {
  decodeFailure,
  decodeInteger,
  decodeRecord,
  decodeSuccess,
  type DecodeResult,
} from "./validation.ts";

export const maxPullEvents = 500 as const;
export const maxPushCommands = 100 as const;
export const maxSnapshotEntities = 500 as const;
export const maxPushRequestBytes = 2 * 1024 * 1024;
export const maxPullResponseBytes = 4 * 1024 * 1024;
export const maxSnapshotResponseBytes = 4 * 1024 * 1024;

/** Stable change-log head for one pull sequence; never editor or product content. */
export type SyncHead = Readonly<{
  capturedAt: IsoDateTime;
  cursor: SyncCursor;
  organizationId: OrganizationId;
}>;

export type ProductSnapshot = Readonly<{
  artifacts: readonly Artifact[];
  capturedAt: IsoDateTime;
  cursor: SyncCursor;
  members: readonly OrganizationMember[];
  messages: readonly Message[];
  organization: Organization;
  projects: readonly Project[];
  threads: readonly Thread[];
}>;

export const snapshotSections = [
  "organization-member",
  "project",
  "thread",
  "message",
  "artifact",
] as const;

export type SnapshotSection = (typeof snapshotSections)[number];

export type SnapshotPosition =
  | Readonly<{
      id: string;
      section: Exclude<SnapshotSection, "message">;
    }>
  | Readonly<{
      id: string;
      ordinal: MessageOrdinal;
      section: "message";
      threadId: string;
    }>;

export type SnapshotPageRequest = Readonly<{
  after: SnapshotPosition | null;
  limit: number;
  organizationId: OrganizationId;
  through: SyncCursor | null;
}>;

export type SnapshotEntity = Readonly<{
  entity: Exclude<ProductEntity, Organization>;
  section: SnapshotSection;
}>;

export type SnapshotPageResponse = Readonly<{
  entities: readonly SnapshotEntity[];
  hasMore: boolean;
  head: SyncHead;
  next: SnapshotPosition | null;
  organization: Organization;
}>;

export type PullEventsRequest = Readonly<{
  after: SyncCursor | null;
  limit: number;
  organizationId: OrganizationId;
  through: SyncCursor | null;
}>;

export type PullEventsResponse = Readonly<{
  events: readonly ProductEvent[];
  hasMore: boolean;
  nextCursor: SyncCursor;
  head: SyncHead;
}>;

export type PushCommandsRequest = Readonly<{
  commands: readonly ProductMutation[];
  organizationId: OrganizationId;
}>;

export type AcceptedCommandResult = Readonly<{
  commandId: CommandId;
  cursor: SyncCursor;
  eventCount: number;
  status: "accepted";
}>;

export type PushCommandsResponse = Readonly<{
  results: readonly AcceptedCommandResult[];
}>;

const issuesOf = (results: readonly DecodeResult<unknown>[]) =>
  results.flatMap((result) => (result.ok ? [] : result.issues));

const enforceSerializedBound = <Value>(
  input: Value,
  maximumBytes: number,
  path: string,
): DecodeResult<Value> => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return decodeFailure(path, "invalid_format", "Expected JSON-serializable data.");
  }
  if (serialized === undefined) {
    return decodeFailure(path, "invalid_format", "Expected JSON-serializable data.");
  }
  return new TextEncoder().encode(serialized).byteLength <= maximumBytes
    ? decodeSuccess(input)
    : decodeFailure(path, "out_of_range", `Serialized data exceeds ${maximumBytes} bytes.`);
};

const decodeEntityArray = <Entity extends ProductEntity>(
  input: unknown,
  entityType: ProductEntityType,
  path: string,
): DecodeResult<readonly Entity[]> => {
  if (!Array.isArray(input)) return decodeFailure(path, "invalid_type", "Expected an array.");
  const decoded = input.map((entity, index) =>
    decodeProductEntity(entityType, entity, `${path}[${index}]`),
  );
  const issues = issuesOf(decoded);
  return issues.length > 0
    ? { ok: false, issues }
    : decodeSuccess(decoded.flatMap((entity) => (entity.ok ? [entity.value as Entity] : [])));
};

export const decodeProductSnapshot = (input: unknown): DecodeResult<ProductSnapshot> => {
  const record = decodeRecord(input, "$snapshot");
  if (!record.ok) return record;
  const snapshotKeys = new Set([
    "artifacts",
    "capturedAt",
    "cursor",
    "members",
    "messages",
    "organization",
    "projects",
    "threads",
  ]);
  const unknownKey = Object.keys(record.value).find((key) => !snapshotKeys.has(key));
  if (unknownKey !== undefined) {
    return decodeFailure(
      `$snapshot.${unknownKey}`,
      "unknown_variant",
      "Unknown product snapshot field.",
    );
  }
  const organization = decodeProductEntity(
    "organization",
    record.value.organization,
    "$snapshot.organization",
  );
  const cursor = decodeSyncCursor(record.value.cursor, "$snapshot.cursor");
  const capturedAt = decodeIsoDateTime(record.value.capturedAt, "$snapshot.capturedAt");
  const members = decodeEntityArray<OrganizationMember>(
    record.value.members,
    "organization-member",
    "$snapshot.members",
  );
  const projects = decodeEntityArray<Project>(
    record.value.projects,
    "project",
    "$snapshot.projects",
  );
  const threads = decodeEntityArray<Thread>(record.value.threads, "thread", "$snapshot.threads");
  const messages = decodeEntityArray<Message>(
    record.value.messages,
    "message",
    "$snapshot.messages",
  );
  const artifacts = decodeEntityArray<Artifact>(
    record.value.artifacts,
    "artifact",
    "$snapshot.artifacts",
  );
  const results = [
    organization,
    cursor,
    capturedAt,
    members,
    projects,
    threads,
    messages,
    artifacts,
  ] as const;
  const issues = issuesOf(results);
  if (issues.length > 0) return { ok: false, issues };
  if (
    !organization.ok ||
    !cursor.ok ||
    !capturedAt.ok ||
    !members.ok ||
    !projects.ok ||
    !threads.ok ||
    !messages.ok ||
    !artifacts.ok
  ) {
    return decodeFailure("$snapshot", "invalid_type", "Invalid product snapshot.");
  }
  const organizationValue = organization.value as Organization;
  const scopedEntities: readonly Readonly<{ organizationId: OrganizationId }>[] = [
    ...members.value,
    ...projects.value,
    ...threads.value,
    ...messages.value,
    ...artifacts.value,
  ];
  if (scopedEntities.some((entity) => entity.organizationId !== organizationValue.id)) {
    return decodeFailure(
      "$snapshot",
      "invalid_format",
      "Every snapshot entity must belong to its organization.",
    );
  }
  const duplicateIdentity = (
    values: readonly string[],
    path: string,
  ): DecodeResult<ProductSnapshot> | null => {
    const seen = new Set<string>();
    const duplicateIndex = values.findIndex((value) => {
      if (seen.has(value)) return true;
      seen.add(value);
      return false;
    });
    return duplicateIndex === -1
      ? null
      : decodeFailure(
          `${path}[${duplicateIndex}]`,
          "invalid_format",
          "Snapshot entity identities must be unique within each collection.",
        );
  };
  const duplicate =
    duplicateIdentity(
      members.value.map((member) => member.userId),
      "$snapshot.members",
    ) ??
    duplicateIdentity(
      projects.value.map((project) => project.id),
      "$snapshot.projects",
    ) ??
    duplicateIdentity(
      threads.value.map((thread) => thread.id),
      "$snapshot.threads",
    ) ??
    duplicateIdentity(
      messages.value.map((message) => message.id),
      "$snapshot.messages",
    ) ??
    duplicateIdentity(
      artifacts.value.map((artifact) => artifact.id),
      "$snapshot.artifacts",
    );
  if (duplicate !== null) return duplicate;

  const lastOrdinalByThread = new Map<string, bigint>();
  const invalidMessageOrderIndex = messages.value.findIndex((message) => {
    const ordinal = BigInt(message.ordinal);
    const previous = lastOrdinalByThread.get(message.threadId);
    lastOrdinalByThread.set(message.threadId, ordinal);
    return previous !== undefined && ordinal <= previous;
  });
  if (invalidMessageOrderIndex !== -1) {
    return decodeFailure(
      `$snapshot.messages[${invalidMessageOrderIndex}].ordinal`,
      "invalid_format",
      "Messages in each thread must have unique, strictly increasing durable ordinals.",
    );
  }

  const projectsById = new Map(projects.value.map((project) => [project.id, project]));
  const threadsById = new Map(threads.value.map((thread) => [thread.id, thread]));
  const orphanThreadIndex = threads.value.findIndex(
    (thread) => !projectsById.has(thread.projectId),
  );
  if (orphanThreadIndex !== -1) {
    return decodeFailure(
      `$snapshot.threads[${orphanThreadIndex}].projectId`,
      "invalid_format",
      "Snapshot threads must reference an included project.",
    );
  }
  const invalidMessageIndex = messages.value.findIndex((message) => {
    const thread = threadsById.get(message.threadId);
    return thread === undefined || thread.projectId !== message.projectId;
  });
  if (invalidMessageIndex !== -1) {
    return decodeFailure(
      `$snapshot.messages[${invalidMessageIndex}]`,
      "invalid_format",
      "Snapshot messages must reference an included thread in the same project.",
    );
  }
  const invalidArtifactIndex = artifacts.value.findIndex((artifact) => {
    if (!projectsById.has(artifact.projectId)) return true;
    if (artifact.kind === "note" || artifact.threadId === null) return false;
    return threadsById.get(artifact.threadId)?.projectId !== artifact.projectId;
  });
  if (invalidArtifactIndex !== -1) {
    return decodeFailure(
      `$snapshot.artifacts[${invalidArtifactIndex}]`,
      "invalid_format",
      "Snapshot artifacts must reference an included project and an optional thread in that project.",
    );
  }
  return decodeSuccess({
    organization: organizationValue,
    cursor: cursor.value,
    capturedAt: capturedAt.value,
    members: members.value,
    projects: projects.value,
    threads: threads.value,
    messages: messages.value,
    artifacts: artifacts.value,
  });
};

const decodeSnapshotSection = (input: unknown, path: string): DecodeResult<SnapshotSection> =>
  typeof input === "string" && snapshotSections.includes(input as SnapshotSection)
    ? decodeSuccess(input as SnapshotSection)
    : decodeFailure(path, "unknown_variant", "Expected a product snapshot section.");

const decodeSnapshotPosition = (input: unknown, path: string): DecodeResult<SnapshotPosition> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const section = decodeSnapshotSection(record.value.section, `${path}.section`);
  if (!section.ok) return section;
  const allowed = new Set(
    section.value === "message" ? ["id", "ordinal", "section", "threadId"] : ["id", "section"],
  );
  const unknownKey = Object.keys(record.value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    return decodeFailure(
      `${path}.${unknownKey}`,
      "unknown_variant",
      "Unknown snapshot position field.",
    );
  }
  const id = decodeId<string>(record.value.id, `${path}.id`);
  if (!id.ok) return id;
  if (section.value !== "message") return decodeSuccess({ section: section.value, id: id.value });
  const threadId = decodeId<string>(record.value.threadId, `${path}.threadId`);
  const ordinal = decodeMessageOrdinal(record.value.ordinal, `${path}.ordinal`);
  const issues = issuesOf([threadId, ordinal]);
  return issues.length > 0
    ? { ok: false, issues }
    : threadId.ok && ordinal.ok
      ? decodeSuccess({
          section: "message",
          threadId: threadId.value,
          ordinal: ordinal.value,
          id: id.value,
        })
      : decodeFailure(path, "invalid_type", "Invalid message snapshot position.");
};

export const decodeSnapshotPageRequest = (input: unknown): DecodeResult<SnapshotPageRequest> => {
  const record = decodeRecord(input, "$snapshotPage");
  if (!record.ok) return record;
  const allowed = new Set(["after", "limit", "organizationId", "through"]);
  const unknownKey = Object.keys(record.value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    return decodeFailure(
      `$snapshotPage.${unknownKey}`,
      "unknown_variant",
      "Unknown snapshot page request field.",
    );
  }
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$snapshotPage.organizationId",
  );
  const limit = decodeInteger(record.value.limit, "$snapshotPage.limit", {
    min: 1,
    max: maxSnapshotEntities,
  });
  const through =
    record.value.through === null
      ? decodeSuccess<SyncCursor | null>(null)
      : decodeSyncCursor(record.value.through, "$snapshotPage.through");
  const after =
    record.value.after === null
      ? decodeSuccess<SnapshotPosition | null>(null)
      : decodeSnapshotPosition(record.value.after, "$snapshotPage.after");
  const issues = issuesOf([organizationId, limit, through, after]);
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !limit.ok || !through.ok || !after.ok) {
    return decodeFailure("$snapshotPage", "invalid_type", "Invalid snapshot page request.");
  }
  if ((through.value === null) !== (after.value === null)) {
    return decodeFailure(
      "$snapshotPage",
      "invalid_format",
      "The initial page has no head or position; continuation pages require both.",
    );
  }
  return decodeSuccess({
    organizationId: organizationId.value,
    limit: limit.value,
    through: through.value,
    after: after.value,
  });
};

const snapshotEntityPosition = (record: SnapshotEntity): SnapshotPosition => {
  if (record.section === "organization-member") {
    return { section: record.section, id: (record.entity as OrganizationMember).userId };
  }
  if (record.section === "message") {
    const message = record.entity as Message;
    return {
      section: record.section,
      threadId: message.threadId,
      ordinal: message.ordinal,
      id: message.id,
    };
  }
  return {
    section: record.section,
    id: (record.entity as Exclude<ProductEntity, Organization | OrganizationMember | Message>).id,
  };
};

const compareSnapshotPosition = (left: SnapshotPosition, right: SnapshotPosition): number => {
  const section = snapshotSections.indexOf(left.section) - snapshotSections.indexOf(right.section);
  if (section !== 0) return section;
  if (left.section === "message" && right.section === "message") {
    const thread = left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
    if (thread !== 0) return thread;
    const leftOrdinal = BigInt(left.ordinal);
    const rightOrdinal = BigInt(right.ordinal);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal < rightOrdinal ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export const decodeSnapshotPageResponse = (
  input: unknown,
  request?: SnapshotPageRequest,
): DecodeResult<SnapshotPageResponse> => {
  const bounded = enforceSerializedBound(input, maxSnapshotResponseBytes, "$snapshotPageResponse");
  if (!bounded.ok) return bounded;
  const record = decodeRecord(bounded.value, "$snapshotPageResponse");
  if (!record.ok) return record;
  const allowed = new Set(["entities", "hasMore", "head", "next", "organization"]);
  const unknownKey = Object.keys(record.value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    return decodeFailure(
      `$snapshotPageResponse.${unknownKey}`,
      "unknown_variant",
      "Unknown snapshot page response field.",
    );
  }
  const organization = decodeProductEntity(
    "organization",
    record.value.organization,
    "$snapshotPageResponse.organization",
  );
  const headRecord = decodeRecord(record.value.head, "$snapshotPageResponse.head");
  let head: DecodeResult<SyncHead>;
  if (!headRecord.ok) {
    head = headRecord;
  } else {
    const organizationId = decodeId<OrganizationId>(
      headRecord.value.organizationId,
      "$snapshotPageResponse.head.organizationId",
    );
    const cursor = decodeSyncCursor(headRecord.value.cursor, "$snapshotPageResponse.head.cursor");
    const capturedAt = decodeIsoDateTime(
      headRecord.value.capturedAt,
      "$snapshotPageResponse.head.capturedAt",
    );
    const unknownHeadKey = Object.keys(headRecord.value).find(
      (key) => key !== "organizationId" && key !== "cursor" && key !== "capturedAt",
    );
    const headIssues = issuesOf([organizationId, cursor, capturedAt]);
    head =
      unknownHeadKey !== undefined
        ? decodeFailure(
            `$snapshotPageResponse.head.${unknownHeadKey}`,
            "unknown_variant",
            "Unknown snapshot head field.",
          )
        : headIssues.length > 0
          ? { ok: false, issues: headIssues }
          : organizationId.ok && cursor.ok && capturedAt.ok
            ? decodeSuccess({
                organizationId: organizationId.value,
                cursor: cursor.value,
                capturedAt: capturedAt.value,
              })
            : decodeFailure("$snapshotPageResponse.head", "invalid_type", "Invalid snapshot head.");
  }
  const next =
    record.value.next === null
      ? decodeSuccess<SnapshotPosition | null>(null)
      : decodeSnapshotPosition(record.value.next, "$snapshotPageResponse.next");
  if (typeof record.value.hasMore !== "boolean") {
    return decodeFailure("$snapshotPageResponse.hasMore", "invalid_type", "Expected a boolean.");
  }
  if (!Array.isArray(record.value.entities)) {
    return decodeFailure("$snapshotPageResponse.entities", "invalid_type", "Expected an array.");
  }
  if (record.value.entities.length > maxSnapshotEntities) {
    return decodeFailure(
      "$snapshotPageResponse.entities",
      "out_of_range",
      `Snapshot page exceeds ${maxSnapshotEntities} entities.`,
    );
  }
  const decodedEntities = record.value.entities.map(
    (value, index): DecodeResult<SnapshotEntity> => {
      const itemPath = `$snapshotPageResponse.entities[${index}]`;
      const item = decodeRecord(value, itemPath);
      if (!item.ok) return item;
      const unknownItemKey = Object.keys(item.value).find(
        (key) => key !== "section" && key !== "entity",
      );
      if (unknownItemKey !== undefined) {
        return decodeFailure(
          `${itemPath}.${unknownItemKey}`,
          "unknown_variant",
          "Unknown snapshot entity field.",
        );
      }
      const section = decodeSnapshotSection(item.value.section, `${itemPath}.section`);
      if (!section.ok) return section;
      const entity = decodeProductEntity(section.value, item.value.entity, `${itemPath}.entity`);
      return entity.ok
        ? decodeSuccess({
            section: section.value,
            entity: entity.value as Exclude<ProductEntity, Organization>,
          })
        : entity;
    },
  );
  const issues = issuesOf([organization, head, next, ...decodedEntities]);
  if (issues.length > 0) return { ok: false, issues };
  if (!organization.ok || !head.ok || !next.ok || decodedEntities.some((item) => !item.ok)) {
    return decodeFailure(
      "$snapshotPageResponse",
      "invalid_type",
      "Invalid snapshot page response.",
    );
  }
  const entities = decodedEntities.flatMap((item) => (item.ok ? [item.value] : []));
  const organizationValue = organization.value as Organization;
  if (
    head.value.organizationId !== organizationValue.id ||
    entities.some((item) =>
      "organizationId" in item.entity ? item.entity.organizationId !== organizationValue.id : true,
    )
  ) {
    return decodeFailure(
      "$snapshotPageResponse",
      "invalid_format",
      "Snapshot page crosses organization scope.",
    );
  }
  const positions = entities.map(snapshotEntityPosition);
  if (
    positions.some(
      (position, index) =>
        index > 0 && compareSnapshotPosition(positions[index - 1]!, position) >= 0,
    )
  ) {
    return decodeFailure(
      "$snapshotPageResponse.entities",
      "invalid_format",
      "Snapshot entities must be uniquely ordered by section and identity.",
    );
  }
  if (request !== undefined) {
    if (request.organizationId !== head.value.organizationId) {
      return decodeFailure(
        "$snapshotPageResponse.head",
        "invalid_format",
        "Snapshot scope changed.",
      );
    }
    if (request.through !== null && request.through !== head.value.cursor) {
      return decodeFailure(
        "$snapshotPageResponse.head.cursor",
        "invalid_format",
        "Snapshot head changed.",
      );
    }
    if (
      request.after !== null &&
      positions.some((position) => compareSnapshotPosition(position, request.after!) <= 0)
    ) {
      return decodeFailure(
        "$snapshotPageResponse.entities",
        "invalid_format",
        "Snapshot page did not advance beyond its continuation.",
      );
    }
  }
  const hasMore = record.value.hasMore;
  const expectedNext = positions.at(-1) ?? null;
  if (
    (hasMore && (expectedNext === null || next.value === null)) ||
    (!hasMore && next.value !== null) ||
    (next.value !== null &&
      (expectedNext === null || compareSnapshotPosition(next.value, expectedNext) !== 0))
  ) {
    return decodeFailure(
      "$snapshotPageResponse.next",
      "invalid_format",
      "Snapshot continuation must identify the final emitted entity exactly when more remain.",
    );
  }
  return decodeSuccess({
    organization: organizationValue,
    head: head.value,
    entities,
    hasMore,
    next: next.value,
  });
};

export const decodePullEventsRequest = (input: unknown): DecodeResult<PullEventsRequest> => {
  const record = decodeRecord(input, "$pull");
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => !["after", "limit", "organizationId", "through"].includes(key),
  );
  if (unknownKey !== undefined)
    return decodeFailure(`$pull.${unknownKey}`, "unknown_variant", "Unknown pull request field.");
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$pull.organizationId",
  );
  const after =
    record.value.after === null
      ? decodeSuccess<SyncCursor | null>(null)
      : decodeSyncCursor(record.value.after, "$pull.after");
  const through =
    record.value.through === null
      ? decodeSuccess<SyncCursor | null>(null)
      : decodeSyncCursor(record.value.through, "$pull.through");
  const limit = decodeInteger(record.value.limit, "$pull.limit", { min: 1, max: maxPullEvents });
  const issues = issuesOf([organizationId, after, through, limit]);
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !after.ok || !through.ok || !limit.ok)
    return decodeFailure("$pull", "invalid_type", "Invalid pull request.");
  return decodeSuccess({
    organizationId: organizationId.value,
    after: after.value,
    through: through.value,
    limit: limit.value,
  });
};

export const decodePushCommandsRequest = (input: unknown): DecodeResult<PushCommandsRequest> => {
  const bounded = enforceSerializedBound(input, maxPushRequestBytes, "$push");
  if (!bounded.ok) return bounded;
  const record = decodeRecord(bounded.value, "$push");
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => key !== "commands" && key !== "organizationId",
  );
  if (unknownKey !== undefined)
    return decodeFailure(`$push.${unknownKey}`, "unknown_variant", "Unknown push request field.");
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    "$push.organizationId",
  );
  if (!Array.isArray(record.value.commands))
    return decodeFailure("$push.commands", "invalid_type", "Expected an array.");
  if (record.value.commands.length < 1 || record.value.commands.length > maxPushCommands)
    return decodeFailure(
      "$push.commands",
      "out_of_range",
      `Expected between 1 and ${maxPushCommands} commands.`,
    );
  const commands = record.value.commands.map((command, index) =>
    decodeProductMutation(command, `$push.commands[${index}]`),
  );
  const issues = issuesOf([organizationId, ...commands]);
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || commands.some((command) => !command.ok))
    return decodeFailure("$push", "invalid_type", "Invalid push request.");
  const decodedCommands = commands.flatMap((command) => (command.ok ? [command.value] : []));
  if (
    new Set(decodedCommands.map((command) => command.commandId)).size !== decodedCommands.length
  ) {
    return decodeFailure(
      "$push.commands",
      "invalid_format",
      "An atomic push request cannot repeat a command identifier.",
    );
  }
  if (decodedCommands.some((command) => command.organizationId !== organizationId.value))
    return decodeFailure(
      "$push.commands",
      "invalid_format",
      "Every command must target the request organization.",
    );
  return decodeSuccess({ organizationId: organizationId.value, commands: decodedCommands });
};

const decodeSyncHead = (input: unknown, path: string): DecodeResult<SyncHead> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => !["capturedAt", "cursor", "organizationId"].includes(key),
  );
  if (unknownKey !== undefined)
    return decodeFailure(`${path}.${unknownKey}`, "unknown_variant", "Unknown sync head field.");
  const organizationId = decodeId<OrganizationId>(
    record.value.organizationId,
    `${path}.organizationId`,
  );
  const cursor = decodeSyncCursor(record.value.cursor, `${path}.cursor`);
  const capturedAt = decodeIsoDateTime(record.value.capturedAt, `${path}.capturedAt`);
  const issues = issuesOf([organizationId, cursor, capturedAt]);
  if (issues.length > 0) return { ok: false, issues };
  if (!organizationId.ok || !cursor.ok || !capturedAt.ok)
    return decodeFailure(path, "invalid_type", "Invalid sync head.");
  return decodeSuccess({
    organizationId: organizationId.value,
    cursor: cursor.value,
    capturedAt: capturedAt.value,
  });
};

export type PullEventsContinuity = Readonly<{ after: SyncCursor | null }>;

export const decodePullEventsResponse = (
  input: unknown,
  continuity?: PullEventsContinuity,
): DecodeResult<PullEventsResponse> => {
  const bounded = enforceSerializedBound(input, maxPullResponseBytes, "$pullResponse");
  if (!bounded.ok) return bounded;
  const record = decodeRecord(bounded.value, "$pullResponse");
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => !["events", "hasMore", "head", "nextCursor"].includes(key),
  );
  if (unknownKey !== undefined)
    return decodeFailure(
      `$pullResponse.${unknownKey}`,
      "unknown_variant",
      "Unknown pull response field.",
    );
  if (!Array.isArray(record.value.events))
    return decodeFailure("$pullResponse.events", "invalid_type", "Expected an array.");
  const events = record.value.events.map((event, index) =>
    decodeProductEvent(event, `$pullResponse.events[${index}]`),
  );
  const nextCursor = decodeSyncCursor(record.value.nextCursor, "$pullResponse.nextCursor");
  const head = decodeSyncHead(record.value.head, "$pullResponse.head");
  const hasMore =
    typeof record.value.hasMore === "boolean"
      ? decodeSuccess(record.value.hasMore)
      : decodeFailure<boolean>("$pullResponse.hasMore", "invalid_type", "Expected a boolean.");
  const issues = issuesOf([...events, nextCursor, head, hasMore]);
  if (issues.length > 0) return { ok: false, issues };
  if (!nextCursor.ok || !head.ok || !hasMore.ok)
    return decodeFailure("$pullResponse", "invalid_type", "Invalid pull response.");
  const decodedEvents = events.flatMap((event) => (event.ok ? [event.value] : []));
  if (hasMore.value && decodedEvents.length === 0) {
    return decodeFailure(
      "$pullResponse.events",
      "invalid_format",
      "A page with more results must contain at least one event.",
    );
  }
  for (let index = 1; index < decodedEvents.length; index += 1) {
    if (BigInt(decodedEvents[index - 1]!.cursor) + 1n !== BigInt(decodedEvents[index]!.cursor)) {
      return decodeFailure(
        `$pullResponse.events[${index}].cursor`,
        "invalid_format",
        "Event cursors must be unique, increasing, and contiguous.",
      );
    }
  }
  if (continuity !== undefined) {
    const after = BigInt(continuity.after ?? "0");
    const firstCursor = decodedEvents[0]?.cursor;
    if (
      firstCursor === undefined
        ? BigInt(nextCursor.value) !== after
        : BigInt(firstCursor) !== after + 1n
    ) {
      return decodeFailure(
        "$pullResponse.nextCursor",
        "invalid_format",
        "The page must continue exactly after the requested cursor without skipping events.",
      );
    }
  }
  if (
    decodedEvents.some((event) => BigInt(event.cursor) > BigInt(nextCursor.value)) ||
    (decodedEvents.length > 0 && decodedEvents.at(-1)!.cursor !== nextCursor.value) ||
    BigInt(nextCursor.value) > BigInt(head.value.cursor)
  ) {
    return decodeFailure(
      "$pullResponse.nextCursor",
      "invalid_format",
      "The page cursor must include every event and cannot exceed the stable sync head.",
    );
  }
  return decodeSuccess({
    events: decodedEvents,
    nextCursor: nextCursor.value,
    head: head.value,
    hasMore: hasMore.value,
  });
};

const decodeCommandResult = (input: unknown, path: string): DecodeResult<AcceptedCommandResult> => {
  const record = decodeRecord(input, path);
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find(
    (key) => !["commandId", "cursor", "eventCount", "status"].includes(key),
  );
  if (unknownKey !== undefined)
    return decodeFailure(
      `${path}.${unknownKey}`,
      "unknown_variant",
      "Unknown command result field.",
    );
  const commandId = decodeId<CommandId>(record.value.commandId, `${path}.commandId`);
  if (!commandId.ok) return commandId;
  if (record.value.status === "accepted") {
    const cursor = decodeSyncCursor(record.value.cursor, `${path}.cursor`);
    const eventCount = decodeInteger(record.value.eventCount, `${path}.eventCount`, {
      min: 1,
      max: 32,
    });
    const issues = issuesOf([cursor, eventCount]);
    if (issues.length > 0) return { ok: false, issues };
    if (cursor.ok && eventCount.ok)
      return decodeSuccess({
        status: "accepted",
        commandId: commandId.value,
        cursor: cursor.value,
        eventCount: eventCount.value,
      });
  }
  return decodeFailure(`${path}.status`, "unknown_variant", "Unknown command result status.");
};

export const decodePushCommandsResponse = (input: unknown): DecodeResult<PushCommandsResponse> => {
  const record = decodeRecord(input, "$pushResponse");
  if (!record.ok) return record;
  const unknownKey = Object.keys(record.value).find((key) => key !== "results");
  if (unknownKey !== undefined)
    return decodeFailure(
      `$pushResponse.${unknownKey}`,
      "unknown_variant",
      "Unknown push response field.",
    );
  if (!Array.isArray(record.value.results))
    return decodeFailure("$pushResponse.results", "invalid_type", "Expected an array.");
  const results = record.value.results.map((result, index) =>
    decodeCommandResult(result, `$pushResponse.results[${index}]`),
  );
  const issues = issuesOf(results);
  if (issues.length > 0) return { ok: false, issues };
  const decodedResults = results.flatMap((result) => (result.ok ? [result.value] : []));
  if (new Set(decodedResults.map((result) => result.commandId)).size !== decodedResults.length) {
    return decodeFailure(
      "$pushResponse.results",
      "invalid_format",
      "An atomic push response must contain at most one receipt per command.",
    );
  }
  return decodeSuccess({ results: decodedResults });
};
