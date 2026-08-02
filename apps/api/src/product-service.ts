import type {
  CommandId,
  IsoDateTime,
  OrganizationId,
  SyncCursor,
  UserId,
} from "@glass/contracts/ids";
import {
  decodeNoteContentResponse,
  decodeOpenEditorNoteContent,
  type LoadNoteContentRequest,
  type NoteContentResponse,
  type SaveNoteContentRequest,
  type SaveNoteContentResponse,
} from "@glass/contracts/notes";
import type { ListOrganizationsRequest, OrganizationsPage } from "@glass/contracts/organizations";
import {
  decodeProductEvent,
  type ProductEvent,
  type ProductMutation,
  type ProductOperation,
} from "@glass/contracts/events";
import type {
  Artifact,
  JsonValue,
  Message,
  Organization,
  OrganizationMember,
  OrganizationRole,
  ProductEntity,
  ProductEntityType,
  Project,
  Thread,
} from "@glass/contracts/product";
import { decodeJsonValue } from "@glass/contracts/product";
import {
  decodeSnapshotPageResponse,
  decodePullEventsResponse,
  decodePushCommandsResponse,
  maxPullResponseBytes,
  maxSnapshotResponseBytes,
  snapshotSections,
  type AcceptedCommandResult,
  type PullEventsRequest,
  type PullEventsResponse,
  type SnapshotEntity,
  type SnapshotPageRequest,
  type SnapshotPageResponse,
  type SnapshotPosition,
  type PushCommandsRequest,
  type PushCommandsResponse,
} from "@glass/contracts/sync";
import type { Client, QueryResultRow } from "pg";
import { createDocument } from "@openeditor/core";

export type ProductFailureCode =
  | "conflict"
  | "cursor-expired"
  | "cursor-invalid"
  | "forbidden"
  | "invalid"
  | "not-found";

export class ProductFailure extends Error {
  readonly code: ProductFailureCode;
  readonly commandId: string | null;
  readonly currentVersion: number | null;
  readonly retryable: boolean;

  constructor(
    code: ProductFailureCode,
    message: string,
    options: Readonly<{ commandId?: string; currentVersion?: number; retryable?: boolean }> = {},
  ) {
    super(message);
    this.name = "ProductFailure";
    this.code = code;
    this.commandId = options.commandId ?? null;
    this.currentVersion = options.currentVersion ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export interface ProductService {
  listOrganizations(userId: string, request: ListOrganizationsRequest): Promise<OrganizationsPage>;
  loadNoteContent(userId: string, request: LoadNoteContentRequest): Promise<NoteContentResponse>;
  pull(userId: string, request: PullEventsRequest): Promise<PullEventsResponse>;
  push(userId: string, request: PushCommandsRequest): Promise<PushCommandsResponse>;
  saveNoteContent(
    userId: string,
    request: SaveNoteContentRequest,
  ): Promise<SaveNoteContentResponse>;
  snapshot(userId: string, request: SnapshotPageRequest): Promise<SnapshotPageResponse>;
}

type MutationOutcome = Readonly<{
  action: "created" | "deleted" | "updated";
  aggregateId: string;
  aggregateType: ProductEntityType;
  entity: ProductEntity | null;
  version: number;
}>;

type MemberRow = QueryResultRow & {
  created_at: Date | string;
  removed_at: Date | string | null;
  role: OrganizationRole;
  updated_at: Date | string;
  user_id: string;
  version: number;
};

type ReceiptRow = QueryResultRow & {
  cursor: bigint | string;
  request_hash: string;
  result: unknown;
};

const asIsoDateTime = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value : new Date(value)).toISOString() as IsoDateTime;

const asCursor = (value: bigint | number | string): SyncCursor => String(value) as SyncCursor;

const jsonValue = (value: unknown): JsonValue => {
  const decoded = decodeJsonValue(value, "$database.artifact.body");
  if (!decoded.ok) {
    throw new ProductFailure("invalid", "The database returned invalid artifact data.");
  }
  return decoded.value;
};

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProductFailure("invalid", "The database returned an invalid durable JSON value.");
  }
  return parsed as Record<string, unknown>;
};

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const operationHash = (mutation: ProductMutation): Promise<string> =>
  digest(
    JSON.stringify({ organizationId: mutation.organizationId, operation: mutation.operation }),
  );

const slugForOrganization = (name: string, organizationId: string): string => {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `${normalized.length > 0 ? normalized : "organization"}-${organizationId.replaceAll("-", "")}`;
};

const queryOne = async <Row extends QueryResultRow>(
  client: Client,
  text: string,
  values: readonly unknown[] = [],
): Promise<Row | null> => {
  const result = await client.query<Row>(text, [...values]);
  return result.rows[0] ?? null;
};

const requireRow = <Row>(
  row: Row | null,
  message: string,
  options: Readonly<{ commandId?: string; currentVersion?: number }> = {},
): Row => {
  if (row === null) throw new ProductFailure("not-found", message, options);
  return row;
};

const memberEntity = (organizationId: string, row: MemberRow): OrganizationMember => ({
  organizationId: organizationId as OrganizationId,
  userId: row.user_id as UserId,
  role: row.role,
  version: row.version,
  createdAt: asIsoDateTime(row.created_at),
  updatedAt: asIsoDateTime(row.updated_at),
});

const activeMembership = async (
  client: Client,
  organizationId: string,
  userId: string,
  lock = false,
): Promise<MemberRow | null> =>
  queryOne<MemberRow>(
    client,
    `select user_id, role, version, created_at, updated_at, removed_at
       from organization_members
      where organization_id = $1 and user_id = $2 and removed_at is null
      ${lock ? "for update" : ""}`,
    [organizationId, userId],
  );

const requireRole = (
  role: OrganizationRole,
  allowed: readonly OrganizationRole[],
  operation: ProductOperation,
): void => {
  if (!allowed.includes(role)) {
    throw new ProductFailure(
      "forbidden",
      `The ${operation.kind} operation requires an organization administrator.`,
    );
  }
};

const requireActiveProject = async (
  client: Client,
  organizationId: string,
  projectId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select id from projects
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, projectId],
  );
  if (row === null) throw new ProductFailure("not-found", "The project does not exist.");
};

const requireActiveThread = async (
  client: Client,
  organizationId: string,
  threadId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select t.id
       from threads t
       join projects p on p.organization_id = t.organization_id and p.id = t.project_id
      where t.organization_id = $1 and t.id = $2
        and t.archived_at is null and p.archived_at is null`,
    [organizationId, threadId],
  );
  if (row === null) throw new ProductFailure("not-found", "The active thread does not exist.");
};

const requireActiveMessage = async (
  client: Client,
  organizationId: string,
  messageId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select m.id
       from messages m
       join threads t on t.organization_id = m.organization_id and t.id = m.thread_id
       join projects p on p.organization_id = t.organization_id and p.id = t.project_id
      where m.organization_id = $1 and m.id = $2 and m.deleted_at is null
        and t.archived_at is null and p.archived_at is null`,
    [organizationId, messageId],
  );
  if (row === null) throw new ProductFailure("not-found", "The active message does not exist.");
};

const requireArtifactInActiveProject = async (
  client: Client,
  organizationId: string,
  artifactId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select a.id
       from artifacts a
       join projects p on p.organization_id = a.organization_id and p.id = a.project_id
      where a.organization_id = $1 and a.id = $2
        and a.archived_at is null and p.archived_at is null`,
    [organizationId, artifactId],
  );
  if (row === null)
    throw new ProductFailure("not-found", "The artifact does not exist in an active project.");
};

const requireActiveNote = async (
  client: Client,
  organizationId: string,
  noteId: string,
): Promise<void> => {
  const row = await queryOne(
    client,
    `select a.id
       from artifacts a
       join projects p on p.organization_id = a.organization_id and p.id = a.project_id
      where a.organization_id = $1 and a.id = $2 and a.kind = 'note'
        and a.archived_at is null and p.archived_at is null`,
    [organizationId, noteId],
  );
  if (row === null) throw new ProductFailure("not-found", "The active note does not exist.");
};

const organizationFromRow = (row: QueryResultRow): Organization => ({
  id: row.id as OrganizationId,
  name: String(row.name),
  version: Number(row.version),
  createdAt: asIsoDateTime(row.created_at as Date | string),
  updatedAt: asIsoDateTime(row.updated_at as Date | string),
});

const projectFromRow = (row: QueryResultRow): Project => ({
  id: row.id as Project["id"],
  organizationId: row.organization_id as OrganizationId,
  name: String(row.name),
  description: row.description === null ? null : String(row.description),
  version: Number(row.version),
  createdAt: asIsoDateTime(row.created_at as Date | string),
  updatedAt: asIsoDateTime(row.updated_at as Date | string),
});

const threadFromRow = (row: QueryResultRow): Thread => ({
  id: row.id as Thread["id"],
  organizationId: row.organization_id as OrganizationId,
  projectId: row.project_id as Thread["projectId"],
  title: row.title === null ? null : String(row.title),
  version: Number(row.version),
  createdAt: asIsoDateTime(row.created_at as Date | string),
  updatedAt: asIsoDateTime(row.updated_at as Date | string),
});

const messageFromRow = (row: QueryResultRow): Message => ({
  id: row.id as Message["id"],
  organizationId: row.organization_id as OrganizationId,
  projectId: row.project_id as Message["projectId"],
  threadId: row.thread_id as Message["threadId"],
  authorUserId: row.author_user_id as UserId,
  ordinal: String(row.ordinal) as Message["ordinal"],
  body: String(row.body),
  version: Number(row.version),
  createdAt: asIsoDateTime(row.created_at as Date | string),
  updatedAt: asIsoDateTime(row.updated_at as Date | string),
});

const artifactFromRow = (row: QueryResultRow): Artifact => {
  const base = {
    id: row.id as Artifact["id"],
    organizationId: row.organization_id as OrganizationId,
    projectId: row.project_id as Artifact["projectId"],
    name: String(row.title),
    version: Number(row.version),
    createdAt: asIsoDateTime(row.created_at as Date | string),
    updatedAt: asIsoDateTime(row.updated_at as Date | string),
  };
  if (row.kind === "note") {
    return {
      ...base,
      kind: "note",
      icon: row.icon === null ? null : String(row.icon),
    };
  }
  if (row.kind !== "agent-output" || row.body === null) {
    throw new ProductFailure("invalid", "The database returned an unsupported artifact.");
  }
  return {
    ...base,
    threadId: row.thread_id === null ? null : (row.thread_id as Thread["id"]),
    kind: "agent-output",
    body: jsonValue(row.body),
  };
};

const currentVersion = async (
  client: Client,
  table: "artifacts" | "messages" | "organizations" | "projects" | "threads",
  organizationId: string,
  id: string,
): Promise<number | null> => {
  const row = await queryOne<QueryResultRow>(
    client,
    `select version from ${table} where ${table === "organizations" ? "id" : "organization_id"} = $1 ${table === "organizations" ? "" : "and id = $2"}`,
    table === "organizations" ? [organizationId] : [organizationId, id],
  );
  return row === null ? null : Number(row.version);
};

const conflict = async (
  client: Client,
  mutation: ProductMutation,
  table: Parameters<typeof currentVersion>[1],
  id: string,
): Promise<never> => {
  const version = await currentVersion(client, table, mutation.organizationId, id);
  throw new ProductFailure("conflict", "The record changed after this command was created.", {
    commandId: mutation.commandId,
    ...(version === null ? {} : { currentVersion: version }),
  });
};

const applyOperation = async (
  client: Client,
  actorUserId: string,
  actorRole: OrganizationRole,
  mutation: ProductMutation,
): Promise<readonly MutationOutcome[]> => {
  const { operation, organizationId } = mutation;
  if (operation.kind === "organization.create") {
    const organizationRow = requireRow(
      await queryOne<QueryResultRow>(
        client,
        `select id, name, version, created_at, updated_at from organizations where id = $1`,
        [organizationId],
      ),
      "The organization was not created.",
    );
    const ownerRow = requireRow(
      await activeMembership(client, organizationId, actorUserId),
      "The organization owner membership was not created.",
    );
    return [
      {
        action: "created",
        aggregateId: organizationId,
        aggregateType: "organization",
        entity: organizationFromRow(organizationRow),
        version: 1,
      },
      {
        action: "created",
        aggregateId: actorUserId,
        aggregateType: "organization-member",
        entity: memberEntity(organizationId, ownerRow),
        version: 1,
      },
    ];
  }

  if (operation.kind === "organization.update") {
    requireRole(actorRole, ["admin", "owner"], operation);
    const row = await queryOne<QueryResultRow>(
      client,
      `update organizations
          set name = $2, version = version + 1, updated_at = now()
        where id = $1 and version = $3
      returning id, name, version, created_at, updated_at`,
      [organizationId, operation.name, operation.expectedVersion],
    );
    if (row === null) return conflict(client, mutation, "organizations", organizationId);
    return [
      {
        action: "updated",
        aggregateId: organizationId,
        aggregateType: "organization",
        entity: organizationFromRow(row),
        version: Number(row.version),
      },
    ];
  }

  if (operation.kind === "member.put") {
    requireRole(actorRole, ["admin", "owner"], operation);
    const target = await queryOne<MemberRow>(
      client,
      `select user_id, role, version, created_at, updated_at, removed_at
         from organization_members
        where organization_id = $1 and user_id = $2
        for update`,
      [organizationId, operation.userId],
    );
    const targetIsActive = target !== null && target.removed_at === null;
    const versionMatches =
      operation.expectedVersion === null
        ? !targetIsActive
        : targetIsActive && target.version === operation.expectedVersion;
    if (!versionMatches) {
      throw new ProductFailure(
        "conflict",
        "The membership changed after this command was created.",
        {
          commandId: mutation.commandId,
          ...(target === null ? {} : { currentVersion: target.version }),
        },
      );
    }
    if (
      (operation.role === "owner" || (targetIsActive && target.role === "owner")) &&
      actorRole !== "owner"
    ) {
      throw new ProductFailure("forbidden", "Only an owner can change owner membership.");
    }
    if (targetIsActive && target.role === "owner" && operation.role !== "owner") {
      const owners = await queryOne<QueryResultRow>(
        client,
        `select count(*)::integer as count from organization_members
          where organization_id = $1 and role = 'owner' and removed_at is null`,
        [organizationId],
      );
      if (Number(owners?.count ?? 0) <= 1) {
        throw new ProductFailure("conflict", "An organization must retain at least one owner.");
      }
    }
    const row =
      operation.expectedVersion === null
        ? await queryOne<MemberRow>(
            client,
            `insert into organization_members
               (organization_id, user_id, role, version, created_at, updated_at, removed_at)
             values ($1, $2, $3, 1, now(), now(), null)
             on conflict (organization_id, user_id) do update
               set role = excluded.role,
                   version = organization_members.version + 1,
                   updated_at = now(),
                   removed_at = null
             where organization_members.removed_at is not null
             returning user_id, role, version, created_at, updated_at, removed_at`,
            [organizationId, operation.userId, operation.role],
          )
        : await queryOne<MemberRow>(
            client,
            `update organization_members
                set role = $3, version = version + 1, updated_at = now()
              where organization_id = $1 and user_id = $2
                and version = $4 and removed_at is null
            returning user_id, role, version, created_at, updated_at, removed_at`,
            [organizationId, operation.userId, operation.role, operation.expectedVersion],
          );
    if (row === null) {
      throw new ProductFailure("conflict", "The membership changed while it was being saved.", {
        commandId: mutation.commandId,
        ...(target === null ? {} : { currentVersion: target.version }),
        retryable: true,
      });
    }
    const entity = memberEntity(organizationId, row);
    return [
      {
        action: operation.expectedVersion === null ? "created" : "updated",
        aggregateId: operation.userId,
        aggregateType: "organization-member",
        entity,
        version: entity.version,
      },
    ];
  }

  if (operation.kind === "member.remove") {
    requireRole(actorRole, ["admin", "owner"], operation);
    const target = await queryOne<MemberRow>(
      client,
      `select user_id, role, version, created_at, updated_at, removed_at
           from organization_members
          where organization_id = $1 and user_id = $2
          for update`,
      [organizationId, operation.userId],
    );
    if (
      target === null ||
      target.removed_at !== null ||
      target.version !== operation.expectedVersion
    ) {
      throw new ProductFailure(
        "conflict",
        "The membership changed after this command was created.",
        {
          commandId: mutation.commandId,
          ...(target === null ? {} : { currentVersion: target.version }),
        },
      );
    }
    if (target.role === "owner") {
      if (actorRole !== "owner") {
        throw new ProductFailure("forbidden", "Only an owner can remove an owner.");
      }
      const owners = await queryOne<QueryResultRow>(
        client,
        `select count(*)::integer as count from organization_members
          where organization_id = $1 and role = 'owner' and removed_at is null`,
        [organizationId],
      );
      if (Number(owners?.count ?? 0) <= 1) {
        throw new ProductFailure("conflict", "The final organization owner cannot be removed.");
      }
    }
    const row = requireRow(
      await queryOne<QueryResultRow>(
        client,
        `update organization_members
            set version = version + 1, updated_at = now(), removed_at = now()
          where organization_id = $1 and user_id = $2
            and version = $3 and removed_at is null
        returning version`,
        [organizationId, operation.userId, operation.expectedVersion],
      ),
      "The member could not be removed.",
    );
    return [
      {
        action: "deleted",
        aggregateId: operation.userId,
        aggregateType: "organization-member",
        entity: null,
        version: Number(row.version),
      },
    ];
  }

  if (operation.kind === "project.create") {
    const row = await queryOne<QueryResultRow>(
      client,
      `insert into projects
         (id, organization_id, name, description, version, created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, 1, $5, now(), now())
       on conflict do nothing
       returning id, organization_id, name, description, version, created_at, updated_at`,
      [operation.projectId, organizationId, operation.name, operation.description, actorUserId],
    );
    if (row === null)
      throw new ProductFailure("conflict", "The project identifier is already in use.");
    const entity = projectFromRow(row);
    return [
      {
        action: "created",
        aggregateId: operation.projectId,
        aggregateType: "project",
        entity,
        version: 1,
      },
    ];
  }

  if (operation.kind === "project.update" || operation.kind === "project.delete") {
    const deleting = operation.kind === "project.delete";
    const row = await queryOne<QueryResultRow>(
      client,
      deleting
        ? `update projects set archived_at = now(), updated_at = now(), version = version + 1
             where organization_id = $1 and id = $2 and version = $3 and archived_at is null
           returning version`
        : `update projects set name = $4, description = $5, updated_at = now(), version = version + 1
             where organization_id = $1 and id = $2 and version = $3 and archived_at is null
           returning id, organization_id, name, description, version, created_at, updated_at`,
      deleting
        ? [organizationId, operation.projectId, operation.expectedVersion]
        : [
            organizationId,
            operation.projectId,
            operation.expectedVersion,
            operation.name,
            operation.description,
          ],
    );
    if (row === null) return conflict(client, mutation, "projects", operation.projectId);
    const version = Number(row.version);
    return [
      {
        action: deleting ? "deleted" : "updated",
        aggregateId: operation.projectId,
        aggregateType: "project",
        entity: deleting ? null : projectFromRow(row),
        version,
      },
    ];
  }

  if (operation.kind === "thread.create") {
    await requireActiveProject(client, organizationId, operation.projectId);
    const row = await queryOne<QueryResultRow>(
      client,
      `insert into threads
         (id, organization_id, project_id, title, version, next_message_ordinal, created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, 1, 1, $5, now(), now())
       on conflict do nothing
       returning id, organization_id, project_id, title, version, created_at, updated_at`,
      [operation.threadId, organizationId, operation.projectId, operation.title, actorUserId],
    );
    if (row === null)
      throw new ProductFailure("conflict", "The thread identifier is already in use.");
    const entity = threadFromRow(row);
    return [
      {
        action: "created",
        aggregateId: operation.threadId,
        aggregateType: "thread",
        entity,
        version: 1,
      },
    ];
  }

  if (operation.kind === "thread.update" || operation.kind === "thread.delete") {
    await requireActiveThread(client, organizationId, operation.threadId);
    const deleting = operation.kind === "thread.delete";
    const row = await queryOne<QueryResultRow>(
      client,
      deleting
        ? `update threads set archived_at = now(), updated_at = now(), version = version + 1
             where organization_id = $1 and id = $2 and version = $3 and archived_at is null
           returning version`
        : `update threads set title = $4, updated_at = now(), version = version + 1
             where organization_id = $1 and id = $2 and version = $3 and archived_at is null
           returning id, organization_id, project_id, title, version, created_at, updated_at`,
      deleting
        ? [organizationId, operation.threadId, operation.expectedVersion]
        : [organizationId, operation.threadId, operation.expectedVersion, operation.title],
    );
    if (row === null) return conflict(client, mutation, "threads", operation.threadId);
    const version = Number(row.version);
    return [
      {
        action: deleting ? "deleted" : "updated",
        aggregateId: operation.threadId,
        aggregateType: "thread",
        entity: deleting ? null : threadFromRow(row),
        version,
      },
    ];
  }

  if (operation.kind === "message.create") {
    await requireActiveProject(client, organizationId, operation.projectId);
    const ordinalRow = await queryOne<QueryResultRow>(
      client,
      `update threads
          set next_message_ordinal = next_message_ordinal + 1, updated_at = updated_at
        where organization_id = $1 and id = $2 and project_id = $3 and archived_at is null
      returning next_message_ordinal - 1 as ordinal`,
      [organizationId, operation.threadId, operation.projectId],
    );
    if (ordinalRow === null)
      throw new ProductFailure("not-found", "The active thread does not exist in this project.");
    const row = await queryOne<QueryResultRow>(
      client,
      `insert into messages
         (id, organization_id, thread_id, ordinal, author_user_id, body, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 1, now(), now())
       on conflict do nothing
       returning id, organization_id, thread_id, ordinal, author_user_id, body, version, created_at, updated_at`,
      [
        operation.messageId,
        organizationId,
        operation.threadId,
        ordinalRow.ordinal,
        actorUserId,
        operation.body,
      ],
    );
    if (row === null)
      throw new ProductFailure("conflict", "The message identifier is already in use.");
    row.project_id = operation.projectId;
    const entity = messageFromRow(row);
    return [
      {
        action: "created",
        aggregateId: operation.messageId,
        aggregateType: "message",
        entity,
        version: 1,
      },
    ];
  }

  if (operation.kind === "message.delete") {
    await requireActiveMessage(client, organizationId, operation.messageId);
    const row = await queryOne<QueryResultRow>(
      client,
      `update messages set deleted_at = now(), updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and version = $3 and deleted_at is null
      returning version`,
      [organizationId, operation.messageId, operation.expectedVersion],
    );
    if (row === null) return conflict(client, mutation, "messages", operation.messageId);
    return [
      {
        action: "deleted",
        aggregateId: operation.messageId,
        aggregateType: "message",
        entity: null,
        version: Number(row.version),
      },
    ];
  }

  if (operation.kind === "note.create") {
    await requireActiveProject(client, organizationId, operation.projectId);
    const row = await queryOne<QueryResultRow>(
      client,
      `insert into artifacts
         (id, organization_id, project_id, thread_id, kind, title, icon, body, version, created_by_user_id, updated_by_user_id, created_at, updated_at)
       values ($1, $2, $3, null, 'note', $4, $5, null, 1, $6, $6, now(), now())
       on conflict do nothing
       returning id, organization_id, project_id, thread_id, kind, title, icon, body, version, created_at, updated_at`,
      [
        operation.artifactId,
        organizationId,
        operation.projectId,
        operation.name,
        operation.icon,
        actorUserId,
      ],
    );
    if (row === null)
      throw new ProductFailure("conflict", "The artifact identifier is already in use.");
    await client.query(
      `insert into note_contents
         (organization_id, artifact_id, content, saved_at, saved_by_user_id)
       values ($1, $2, $3::jsonb, now(), $4)`,
      [organizationId, operation.artifactId, JSON.stringify(createDocument()), actorUserId],
    );
    return [
      {
        action: "created",
        aggregateId: operation.artifactId,
        aggregateType: "artifact",
        entity: artifactFromRow(row),
        version: 1,
      },
    ];
  }

  if (operation.kind === "note.update") {
    await requireActiveNote(client, organizationId, operation.artifactId);
    const row = await queryOne<QueryResultRow>(
      client,
      `update artifacts
          set title = $3, icon = $4, updated_by_user_id = $5,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and kind = 'note'
          and version = $6 and archived_at is null
      returning id, organization_id, project_id, thread_id, kind, title, icon, body, version, created_at, updated_at`,
      [
        organizationId,
        operation.artifactId,
        operation.name,
        operation.icon,
        actorUserId,
        operation.expectedVersion,
      ],
    );
    if (row === null) return conflict(client, mutation, "artifacts", operation.artifactId);
    return [
      {
        action: "updated",
        aggregateId: operation.artifactId,
        aggregateType: "artifact",
        entity: artifactFromRow(row),
        version: Number(row.version),
      },
    ];
  }

  if (operation.kind === "artifact.create") {
    await requireActiveProject(client, organizationId, operation.projectId);
    if (operation.threadId !== null) {
      const thread = await queryOne(
        client,
        `select id from threads
          where organization_id = $1 and id = $2 and project_id = $3 and archived_at is null`,
        [organizationId, operation.threadId, operation.projectId],
      );
      if (thread === null)
        throw new ProductFailure(
          "not-found",
          "The artifact thread does not exist in this project.",
        );
    }
    const row = await queryOne<QueryResultRow>(
      client,
      `insert into artifacts
         (id, organization_id, project_id, thread_id, kind, title, body, version, created_by_user_id, updated_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8, now(), now())
       on conflict do nothing
       returning id, organization_id, project_id, thread_id, kind, title, icon, body, version, created_at, updated_at`,
      [
        operation.artifactId,
        organizationId,
        operation.projectId,
        operation.threadId,
        operation.artifactKind,
        operation.name,
        JSON.stringify(operation.body),
        actorUserId,
      ],
    );
    if (row === null)
      throw new ProductFailure("conflict", "The artifact identifier is already in use.");
    const entity = artifactFromRow(row);
    return [
      {
        action: "created",
        aggregateId: operation.artifactId,
        aggregateType: "artifact",
        entity,
        version: 1,
      },
    ];
  }

  await requireArtifactInActiveProject(client, organizationId, operation.artifactId);
  const row = await queryOne<QueryResultRow>(
    client,
    `update artifacts set archived_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and version = $3 and archived_at is null
    returning version`,
    [organizationId, operation.artifactId, operation.expectedVersion],
  );
  if (row === null) return conflict(client, mutation, "artifacts", operation.artifactId);
  return [
    {
      action: "deleted",
      aggregateId: operation.artifactId,
      aggregateType: "artifact",
      entity: null,
      version: Number(row.version),
    },
  ];
};

const lockSyncHead = async (client: Client, organizationId: string): Promise<void> => {
  const state = await queryOne(
    client,
    `select organization_id from organization_sync_state where organization_id = $1 for update`,
    [organizationId],
  );
  if (state === null) throw new ProductFailure("not-found", "The organization does not exist.");
};

const appendOutcome = async (
  client: Client,
  actorUserId: string,
  mutation: ProductMutation,
  outcome: MutationOutcome,
): Promise<SyncCursor> => {
  const state = requireRow(
    await queryOne<QueryResultRow>(
      client,
      `update organization_sync_state
          set cursor = cursor + 1, updated_at = now()
        where organization_id = $1
      returning cursor`,
      [mutation.organizationId],
    ),
    "The organization synchronization state does not exist.",
  );
  const cursor = asCursor(state.cursor as bigint | string);
  const eventId = crypto.randomUUID();
  await client.query(
    `insert into product_events
       (id, organization_id, cursor, command_id, actor_user_id, aggregate_type, aggregate_id, aggregate_version, type, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())`,
    [
      eventId,
      mutation.organizationId,
      cursor,
      mutation.commandId,
      actorUserId,
      outcome.aggregateType,
      outcome.aggregateId,
      outcome.version,
      `${outcome.aggregateType}.${outcome.action}`,
      JSON.stringify({ action: outcome.action, entity: outcome.entity }),
    ],
  );
  return cursor;
};

const parseCommandResult = (value: unknown): AcceptedCommandResult => {
  const decoded = decodePushCommandsResponse({ results: [value] });
  if (!decoded.ok || decoded.value.results[0] === undefined) {
    throw new ProductFailure("invalid", "A durable command receipt has an invalid status.");
  }
  return decoded.value.results[0];
};

const processMutation = async (
  client: Client,
  actorUserId: string,
  mutation: ProductMutation,
): Promise<AcceptedCommandResult> => {
  const hash = await operationHash(mutation);
  const isCreate = mutation.operation.kind === "organization.create";
  let createdOrganization = false;

  if (isCreate) {
    const existing = await queryOne(client, `select id from organizations where id = $1`, [
      mutation.organizationId,
    ]);
    if (existing === null) {
      await client.query(
        `insert into organizations (id, name, slug, version, created_by_user_id, created_at, updated_at)
         values ($1, $2, $3, 1, $4, now(), now())`,
        [
          mutation.organizationId,
          mutation.operation.name,
          slugForOrganization(mutation.operation.name, mutation.organizationId),
          actorUserId,
        ],
      );
      await client.query(
        `insert into organization_members
           (organization_id, user_id, role, version, created_at, updated_at)
         values ($1, $2, 'owner', 1, now(), now())`,
        [mutation.organizationId, actorUserId],
      );
      await client.query(
        `insert into organization_sync_state (organization_id, cursor, retention_floor, updated_at)
         values ($1, 0, 0, now())`,
        [mutation.organizationId],
      );
      createdOrganization = true;
    }
  }

  await lockSyncHead(client, mutation.organizationId);
  const membership = await activeMembership(client, mutation.organizationId, actorUserId, true);
  if (membership === null) {
    throw new ProductFailure("forbidden", "Active organization membership is required.", {
      commandId: mutation.commandId,
    });
  }

  const receipt = await queryOne<ReceiptRow>(
    client,
    `select request_hash, cursor, result from mutation_receipts
      where organization_id = $1 and actor_user_id = $2 and command_id = $3`,
    [mutation.organizationId, actorUserId, mutation.commandId],
  );
  if (receipt !== null) {
    if (receipt.request_hash !== hash) {
      throw new ProductFailure(
        "conflict",
        "The command identifier was already used for a different operation.",
        { commandId: mutation.commandId },
      );
    }
    return parseCommandResult(receipt.result);
  }

  if (isCreate && !createdOrganization) {
    throw new ProductFailure("conflict", "The organization identifier is already in use.", {
      commandId: mutation.commandId,
    });
  }

  const outcomes = await applyOperation(client, actorUserId, membership.role, mutation);
  let cursor = "0" as SyncCursor;
  for (const outcome of outcomes) {
    // Event cursors are allocated serially so their order is deterministic inside the command.
    // eslint-disable-next-line no-await-in-loop
    cursor = await appendOutcome(client, actorUserId, mutation, outcome);
  }
  const result: AcceptedCommandResult = {
    status: "accepted",
    commandId: mutation.commandId,
    cursor,
    eventCount: outcomes.length,
  };
  await client.query(
    `insert into mutation_receipts
       (organization_id, actor_user_id, command_id, request_hash, cursor, result, accepted_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now())`,
    [
      mutation.organizationId,
      actorUserId,
      mutation.commandId,
      hash,
      cursor,
      JSON.stringify(result),
    ],
  );
  return result;
};

const withTransaction = async <Value>(
  client: Client,
  use: () => Promise<Value>,
): Promise<Value> => {
  const maximumAttempts = 3;
  const attemptTransaction = async (attempt: number): Promise<Value> => {
    await client.query("begin isolation level serializable");
    try {
      const value = await use();
      await client.query("commit");
      return value;
    } catch (cause) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the operation failure; a request-scoped connection is closed by the caller.
      }
      if (cause instanceof ProductFailure) throw cause;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : null;
      if ((code === "40001" || code === "40P01") && attempt < maximumAttempts) {
        return attemptTransaction(attempt + 1);
      }
      if (code === "23503") {
        throw new ProductFailure("not-found", "A referenced cloud record does not exist.");
      }
      if (code === "23505") {
        throw new ProductFailure(
          "conflict",
          "A durable record with this identifier already exists.",
        );
      }
      if (code === "40001" || code === "40P01") {
        throw new ProductFailure(
          "conflict",
          "The concurrent transaction could not be serialized; retry the same command.",
          { retryable: true },
        );
      }
      throw cause;
    }
  };
  return attemptTransaction(1);
};

const authorizeRead = async (
  client: Client,
  organizationId: string,
  userId: string,
): Promise<void> => {
  if ((await activeMembership(client, organizationId, userId)) === null) {
    throw new ProductFailure("forbidden", "Active organization membership is required.");
  }
};

const eventFromRow = (row: QueryResultRow): ProductEvent => {
  const payload = parseJsonObject(row.payload);
  const action = payload.action;
  if (action !== "created" && action !== "updated" && action !== "deleted") {
    throw new ProductFailure("invalid", "A durable product event has an invalid action.");
  }
  const decoded = decodeProductEvent({
    eventId: row.id as ProductEvent["eventId"],
    commandId: row.command_id as CommandId,
    organizationId: row.organization_id as OrganizationId,
    actorUserId: row.actor_user_id as UserId,
    cursor: asCursor(row.cursor as bigint | string),
    aggregateType: row.aggregate_type as ProductEntityType,
    aggregateId: String(row.aggregate_id),
    aggregateVersion: Number(row.aggregate_version),
    action,
    entity: (payload.entity ?? null) as ProductEntity | null,
    occurredAt: asIsoDateTime(row.occurred_at as Date | string),
  });
  if (!decoded.ok) {
    throw new ProductFailure("invalid", "The database returned an invalid durable product event.");
  }
  return decoded.value;
};

export const createPostgresProductService = (client: Client): ProductService => ({
  listOrganizations: (userId, request) =>
    withTransaction(client, async () => {
      const parameters: unknown[] =
        request.after === null
          ? [userId, request.limit + 1]
          : [userId, request.after, request.limit + 1];
      const afterClause = request.after === null ? "" : "and o.id > $2";
      const limitParameter = request.after === null ? "$2" : "$3";
      const result = await client.query<QueryResultRow & MemberRow>(
        `select o.id, o.name, o.version, o.created_at, o.updated_at,
                m.user_id, m.role, m.version as member_version,
                m.created_at as member_created_at, m.updated_at as member_updated_at,
                m.removed_at
           from organization_members m
           join organizations o on o.id = m.organization_id
          where m.user_id = $1 and m.removed_at is null ${afterClause}
          order by o.id asc
          limit ${limitParameter}`,
        parameters,
      );
      const rows = result.rows.slice(0, request.limit);
      const items = rows.map((row) => ({
        organization: organizationFromRow(row),
        membership: memberEntity(String(row.id), {
          ...row,
          version: Number(row.member_version),
          created_at: row.member_created_at as Date | string,
          updated_at: row.member_updated_at as Date | string,
        }),
      }));
      return {
        items,
        nextCursor:
          result.rows.length > request.limit ? (items.at(-1)?.organization.id ?? null) : null,
      };
    }),

  loadNoteContent: (userId, request) =>
    withTransaction(client, async () => {
      await authorizeRead(client, request.organizationId, userId);
      const row = requireRow(
        await queryOne<QueryResultRow>(
          client,
          `select n.content, n.saved_at, n.saved_by_user_id
             from note_contents n
             join artifacts a
               on a.organization_id = n.organization_id and a.id = n.artifact_id
             join projects p
               on p.organization_id = a.organization_id and p.id = a.project_id
            where n.organization_id = $1 and n.artifact_id = $2
              and a.kind = 'note' and a.archived_at is null and p.archived_at is null`,
          [request.organizationId, request.noteId],
        ),
        "The active note does not exist.",
      );
      const decoded = decodeNoteContentResponse({
        organizationId: request.organizationId,
        noteId: request.noteId,
        content:
          typeof row.content === "string" ? (JSON.parse(row.content) as unknown) : row.content,
        savedAt: asIsoDateTime(row.saved_at as Date | string),
        savedByUserId: String(row.saved_by_user_id),
      });
      if (!decoded.ok) {
        throw new ProductFailure("invalid", "The database returned invalid note content.");
      }
      return decoded.value;
    }),

  push: async (userId, request) => {
    if (
      new Set(request.commands.map((command) => command.commandId)).size !== request.commands.length
    ) {
      throw new ProductFailure("invalid", "An atomic push cannot repeat a command identifier.");
    }
    return withTransaction(client, async () => {
      const results: AcceptedCommandResult[] = [];
      for (const mutation of request.commands) {
        // Commands are intentionally ordered because later commands may depend on earlier creates.
        // eslint-disable-next-line no-await-in-loop
        results.push(await processMutation(client, userId, mutation));
      }
      return { results };
    });
  },

  saveNoteContent: (userId, request) =>
    withTransaction(client, async () => {
      await authorizeRead(client, request.organizationId, userId);
      await requireActiveNote(client, request.organizationId, request.noteId);
      const content = decodeOpenEditorNoteContent(request.content, "$saveNoteContent.content");
      if (!content.ok) throw new ProductFailure("invalid", "The note content is invalid.");
      const row = requireRow(
        await queryOne<QueryResultRow>(
          client,
          `update note_contents
              set content = $3::jsonb, saved_at = now(), saved_by_user_id = $4
            where organization_id = $1 and artifact_id = $2
          returning saved_at, saved_by_user_id`,
          [request.organizationId, request.noteId, JSON.stringify(content.value), userId],
        ),
        "The active note content does not exist.",
      );
      return {
        organizationId: request.organizationId,
        noteId: request.noteId,
        savedAt: asIsoDateTime(row.saved_at as Date | string),
        savedByUserId: String(row.saved_by_user_id) as UserId,
      };
    }),

  pull: (userId, request) =>
    withTransaction(client, async () => {
      await authorizeRead(client, request.organizationId, userId);
      const state = requireRow(
        await queryOne<QueryResultRow>(
          client,
          `select cursor, retention_floor, updated_at
             from organization_sync_state
            where organization_id = $1`,
          [request.organizationId],
        ),
        "The organization synchronization state does not exist.",
      );
      const head = BigInt(state.cursor as bigint | string);
      const floor = BigInt(state.retention_floor as bigint | string);
      const after = BigInt(request.after ?? "0");
      const requestedHead = request.through === null ? head : BigInt(request.through);
      if (after < floor)
        throw new ProductFailure("cursor-expired", "The cursor is older than retained events.");
      if (after > head || requestedHead > head || requestedHead < after) {
        throw new ProductFailure(
          "cursor-invalid",
          "The cursor does not belong to the current organization history.",
        );
      }
      const rows = await client.query<QueryResultRow>(
        `with recursive page as (
           select first_event.*, 1::integer as page_count,
                  first_event.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select id, organization_id, cursor, command_id, actor_user_id, aggregate_type,
                      aggregate_id, aggregate_version, payload, occurred_at,
                      (octet_length(payload::text)
                        + octet_length(id) + octet_length(command_id)
                        + octet_length(actor_user_id) + octet_length(aggregate_type)
                        + octet_length(aggregate_id) + 1024)::bigint
                        as conservative_wire_bytes
                 from product_events
                where organization_id = $1 and cursor > $2 and cursor <= $3
                order by cursor asc
                limit 1
             ) first_event
            where first_event.conservative_wire_bytes <= $5
           union all
           select next_event.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_event.conservative_wire_bytes
             from page
             cross join lateral (
               select id, organization_id, cursor, command_id, actor_user_id, aggregate_type,
                      aggregate_id, aggregate_version, payload, occurred_at,
                      (octet_length(payload::text)
                        + octet_length(id) + octet_length(command_id)
                        + octet_length(actor_user_id) + octet_length(aggregate_type)
                        + octet_length(aggregate_id) + 1024)::bigint
                        as conservative_wire_bytes
                 from product_events
                where organization_id = $1 and cursor > page.cursor and cursor <= $3
                order by cursor asc
                limit 1
             ) next_event
            where page.page_count < $4
              and page.cumulative_wire_bytes + next_event.conservative_wire_bytes <= $5
         )
         select id, organization_id, cursor, command_id, actor_user_id, aggregate_type,
                aggregate_id, aggregate_version, payload, occurred_at
           from page
          order by cursor asc`,
        [
          request.organizationId,
          after.toString(),
          requestedHead.toString(),
          request.limit,
          maxPullResponseBytes - 4096,
        ],
      );
      let events = rows.rows.map(eventFromRow);
      const capturedHead =
        requestedHead === head
          ? { captured_at: state.updated_at }
          : requestedHead === 0n
            ? await queryOne<QueryResultRow>(
                client,
                `select created_at as captured_at from organizations where id = $1`,
                [request.organizationId],
              )
            : await queryOne<QueryResultRow>(
                client,
                `select occurred_at as captured_at
                 from product_events
                where organization_id = $1 and cursor = $2`,
                [request.organizationId, requestedHead.toString()],
              );
      if (capturedHead === null) {
        throw new ProductFailure(
          "cursor-expired",
          "The requested synchronization head is no longer retained.",
        );
      }
      const stableHead = {
        organizationId: request.organizationId,
        cursor: asCursor(requestedHead),
        capturedAt: asIsoDateTime(capturedHead.captured_at as Date | string),
      };
      const responseFor = (pageEvents: readonly ProductEvent[]) => {
        const nextCursor = pageEvents.at(-1)?.cursor ?? asCursor(after);
        return {
          events: pageEvents,
          hasMore: BigInt(nextCursor) < requestedHead,
          nextCursor,
          head: stableHead,
        };
      };
      let response = responseFor(events);
      while (
        events.length > 0 &&
        new TextEncoder().encode(JSON.stringify(response)).byteLength > maxPullResponseBytes
      ) {
        events = events.slice(0, -1);
        response = responseFor(events);
      }
      if (response.hasMore && response.events.length === 0) {
        throw new ProductFailure(
          "invalid",
          "A durable product event exceeds the pull response byte boundary.",
        );
      }
      const decodedResponse = decodePullEventsResponse(response, { after: request.after });
      if (!decodedResponse.ok) {
        throw new ProductFailure("invalid", "The database produced an invalid bounded event page.");
      }
      return decodedResponse.value;
    }),

  snapshot: (userId, request) =>
    withTransaction(client, async () => {
      await authorizeRead(client, request.organizationId, userId);
      const state = requireRow(
        await queryOne<QueryResultRow>(
          client,
          `select cursor, retention_floor, updated_at::text as updated_at
             from organization_sync_state where organization_id = $1`,
          [request.organizationId],
        ),
        "The organization synchronization state does not exist.",
      );
      const currentHead = BigInt(state.cursor as bigint | string);
      const retentionFloor = BigInt(state.retention_floor as bigint | string);
      const requestedHead = request.through === null ? currentHead : BigInt(request.through);
      if (requestedHead < retentionFloor) {
        throw new ProductFailure(
          "cursor-expired",
          "The snapshot head is older than retained events.",
        );
      }
      if (requestedHead > currentHead) {
        throw new ProductFailure("cursor-invalid", "The requested snapshot head is in the future.");
      }
      const captured =
        requestedHead === currentHead
          ? { captured_at: state.updated_at }
          : requestedHead === 0n
            ? await queryOne<QueryResultRow>(
                client,
                `select created_at::text as captured_at from organizations where id = $1`,
                [request.organizationId],
              )
            : await queryOne<QueryResultRow>(
                client,
                `select occurred_at::text as captured_at
                   from product_events
                  where organization_id = $1 and cursor = $2`,
                [request.organizationId, requestedHead.toString()],
              );
      if (captured === null) {
        throw new ProductFailure(
          "cursor-expired",
          "The requested snapshot head is no longer retained.",
        );
      }
      const head = {
        organizationId: request.organizationId,
        cursor: asCursor(requestedHead),
        capturedAt: asIsoDateTime(captured.captured_at as Date | string),
      };
      const organizationResult = await client.query<QueryResultRow>(
        `select id, name, version, created_at, updated_at from organizations where id = $1`,
        [request.organizationId],
      );
      const organizationRow = requireRow(
        organizationResult.rows[0] ?? null,
        "The organization does not exist.",
      );
      const organization = organizationFromRow(organizationRow);
      const entities: SnapshotEntity[] = [];
      const conservativeBudget = maxSnapshotResponseBytes - 128 * 1024;
      let conservativeUsed = 0;
      let moreInDatabase = false;
      const afterSection = request.after?.section;
      const sectionCanRun = (section: (typeof snapshotSections)[number]) =>
        afterSection === undefined ||
        snapshotSections.indexOf(section) >= snapshotSections.indexOf(afterSection);
      const remainingCount = () => request.limit + 1 - entities.length;
      const runSection = async (
        section: SnapshotEntity["section"],
        sql: string,
        parameters: readonly unknown[],
        map: (row: QueryResultRow) => SnapshotEntity["entity"],
        hasFollowing: (row: QueryResultRow | null) => Promise<boolean>,
      ) => {
        if (!sectionCanRun(section) || remainingCount() <= 0 || moreInDatabase) return;
        const result = await client.query<QueryResultRow>(sql, [
          ...parameters,
          remainingCount(),
          conservativeBudget - conservativeUsed,
        ]);
        for (const row of result.rows) entities.push({ section, entity: map(row) });
        const finalRow = result.rows.at(-1);
        if (finalRow !== undefined) {
          conservativeUsed += Number(finalRow.cumulative_wire_bytes);
        }
        moreInDatabase ||= await hasFollowing(finalRow ?? null);
      };
      const simpleAfter = (section: Exclude<SnapshotEntity["section"], "message">) =>
        request.after?.section === section ? request.after.id : "";

      await runSection(
        "organization-member",
        `with recursive page as (
           select first_member.*, 1::integer as page_count,
                  first_member.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select m.user_id, m.role, m.version, m.created_at, m.updated_at, m.removed_at,
                      (octet_length(m.user_id) + octet_length(m.role::text) + 1024)::bigint
                        as conservative_wire_bytes
                 from organization_members m
                where m.organization_id = $1 and m.removed_at is null and m.user_id > $3
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1
                       and e.aggregate_type = 'organization-member'
                       and e.aggregate_id = m.user_id and e.type = 'organization-member.created'
                       and e.cursor > $2
                  )
                order by m.user_id limit 1
             ) first_member
            where first_member.conservative_wire_bytes <= $5
           union all
           select next_member.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_member.conservative_wire_bytes
             from page
             cross join lateral (
               select m.user_id, m.role, m.version, m.created_at, m.updated_at, m.removed_at,
                      (octet_length(m.user_id) + octet_length(m.role::text) + 1024)::bigint
                        as conservative_wire_bytes
                 from organization_members m
                where m.organization_id = $1 and m.removed_at is null and m.user_id > page.user_id
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1
                       and e.aggregate_type = 'organization-member'
                       and e.aggregate_id = m.user_id and e.type = 'organization-member.created'
                       and e.cursor > $2
                  )
                order by m.user_id limit 1
             ) next_member
            where page.page_count < $4
              and page.cumulative_wire_bytes + next_member.conservative_wire_bytes <= $5
         )
         select user_id, role, version, created_at, updated_at, removed_at,
                cumulative_wire_bytes
           from page order by user_id`,
        [request.organizationId, requestedHead.toString(), simpleAfter("organization-member")],
        (row) => memberEntity(request.organizationId, row as MemberRow),
        async (row) =>
          Boolean(
            (
              await queryOne<QueryResultRow>(
                client,
                `select exists (
                   select 1 from organization_members m
                    where m.organization_id = $1 and m.removed_at is null and m.user_id > $3
                      and not exists (
                        select 1 from product_events e
                         where e.organization_id = $1
                           and e.aggregate_type = 'organization-member'
                           and e.aggregate_id = m.user_id and e.type = 'organization-member.created'
                           and e.cursor > $2
                      )
                 ) as value`,
                [
                  request.organizationId,
                  requestedHead.toString(),
                  row?.user_id ?? simpleAfter("organization-member"),
                ],
              )
            )?.value,
          ),
      );
      await runSection(
        "project",
        `with recursive page as (
           select first_project.*, 1::integer as page_count,
                  first_project.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select p.id, p.organization_id, p.name, p.description, p.version,
                      p.created_at, p.updated_at,
                      (octet_length(p.id) + octet_length(p.name)
                        + octet_length(coalesce(p.description, '')) + 1024)::bigint
                        as conservative_wire_bytes
                 from projects p
                where p.organization_id = $1 and p.archived_at is null and p.id > $3
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'project'
                       and e.aggregate_id = p.id and e.type = 'project.created' and e.cursor > $2
                  )
                order by p.id limit 1
             ) first_project
            where first_project.conservative_wire_bytes <= $5
           union all
           select next_project.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_project.conservative_wire_bytes
             from page
             cross join lateral (
               select p.id, p.organization_id, p.name, p.description, p.version,
                      p.created_at, p.updated_at,
                      (octet_length(p.id) + octet_length(p.name)
                        + octet_length(coalesce(p.description, '')) + 1024)::bigint
                        as conservative_wire_bytes
                 from projects p
                where p.organization_id = $1 and p.archived_at is null and p.id > page.id
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'project'
                       and e.aggregate_id = p.id and e.type = 'project.created' and e.cursor > $2
                  )
                order by p.id limit 1
             ) next_project
            where page.page_count < $4
              and page.cumulative_wire_bytes + next_project.conservative_wire_bytes <= $5
         )
         select id, organization_id, name, description, version, created_at, updated_at,
                cumulative_wire_bytes
           from page order by id`,
        [request.organizationId, requestedHead.toString(), simpleAfter("project")],
        projectFromRow,
        async (row) =>
          Boolean(
            (
              await queryOne<QueryResultRow>(
                client,
                `select exists (
                   select 1 from projects p
                    where p.organization_id = $1 and p.archived_at is null and p.id > $3
                      and not exists (
                        select 1 from product_events e
                         where e.organization_id = $1 and e.aggregate_type = 'project'
                           and e.aggregate_id = p.id and e.type = 'project.created' and e.cursor > $2
                      )
                 ) as value`,
                [
                  request.organizationId,
                  requestedHead.toString(),
                  row?.id ?? simpleAfter("project"),
                ],
              )
            )?.value,
          ),
      );
      await runSection(
        "thread",
        `with recursive page as (
           select first_thread.*, 1::integer as page_count,
                  first_thread.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select t.id, t.organization_id, t.project_id, t.title, t.version,
                      t.created_at, t.updated_at,
                      (octet_length(t.id) + octet_length(t.project_id)
                        + octet_length(coalesce(t.title, '')) + 1024)::bigint
                        as conservative_wire_bytes
                 from threads t
                 join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                where t.organization_id = $1 and t.archived_at is null and p.archived_at is null
                  and t.id > $3
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'thread'
                       and e.aggregate_id = t.id and e.type = 'thread.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'project'
                       and e.aggregate_id = p.id and e.type = 'project.created' and e.cursor > $2
                  )
                order by t.id limit 1
             ) first_thread
            where first_thread.conservative_wire_bytes <= $5
           union all
           select next_thread.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_thread.conservative_wire_bytes
             from page
             cross join lateral (
               select t.id, t.organization_id, t.project_id, t.title, t.version,
                      t.created_at, t.updated_at,
                      (octet_length(t.id) + octet_length(t.project_id)
                        + octet_length(coalesce(t.title, '')) + 1024)::bigint
                        as conservative_wire_bytes
                 from threads t
                 join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                where t.organization_id = $1 and t.archived_at is null and p.archived_at is null
                  and t.id > page.id
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'thread'
                       and e.aggregate_id = t.id and e.type = 'thread.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e
                     where e.organization_id = $1 and e.aggregate_type = 'project'
                       and e.aggregate_id = p.id and e.type = 'project.created' and e.cursor > $2
                  )
                order by t.id limit 1
             ) next_thread
            where page.page_count < $4
              and page.cumulative_wire_bytes + next_thread.conservative_wire_bytes <= $5
         )
         select id, organization_id, project_id, title, version, created_at, updated_at,
                cumulative_wire_bytes
           from page order by id`,
        [request.organizationId, requestedHead.toString(), simpleAfter("thread")],
        threadFromRow,
        async (row) =>
          Boolean(
            (
              await queryOne<QueryResultRow>(
                client,
                `select exists (
                   select 1 from threads t
                   join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                    where t.organization_id = $1 and t.archived_at is null and p.archived_at is null
                      and t.id > $3
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                          and e.type = 'thread.created' and e.cursor > $2
                      )
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'project' and e.aggregate_id = p.id
                          and e.type = 'project.created' and e.cursor > $2
                      )
                 ) as value`,
                [
                  request.organizationId,
                  requestedHead.toString(),
                  row?.id ?? simpleAfter("thread"),
                ],
              )
            )?.value,
          ),
      );
      const messageAfter = request.after?.section === "message" ? request.after : null;
      await runSection(
        "message",
        `with recursive page as (
           select first_message.*, 1::integer as page_count,
                  first_message.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select m.id, m.organization_id, t.project_id, m.thread_id, m.ordinal,
                      m.author_user_id, m.body, m.version, m.created_at, m.updated_at,
                      (octet_length(m.id) + octet_length(m.thread_id)
                        + octet_length(m.author_user_id) + octet_length(m.body) + 2048)::bigint
                        as conservative_wire_bytes
                 from messages m
                 join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
                 join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                where m.organization_id = $1 and m.deleted_at is null
                  and t.archived_at is null and p.archived_at is null
                  and (m.thread_id, m.ordinal, m.id) > ($3, $4, $5)
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'message' and e.aggregate_id = m.id
                      and e.type = 'message.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                      and e.type = 'thread.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'project' and e.aggregate_id = p.id
                      and e.type = 'project.created' and e.cursor > $2
                  )
                order by m.thread_id, m.ordinal, m.id limit 1
             ) first_message
            where first_message.conservative_wire_bytes <= $7
           union all
           select next_message.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_message.conservative_wire_bytes
             from page
             cross join lateral (
               select m.id, m.organization_id, t.project_id, m.thread_id, m.ordinal,
                      m.author_user_id, m.body, m.version, m.created_at, m.updated_at,
                      (octet_length(m.id) + octet_length(m.thread_id)
                        + octet_length(m.author_user_id) + octet_length(m.body) + 2048)::bigint
                        as conservative_wire_bytes
                 from messages m
                 join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
                 join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                where m.organization_id = $1 and m.deleted_at is null
                  and t.archived_at is null and p.archived_at is null
                  and (m.thread_id, m.ordinal, m.id) > (page.thread_id, page.ordinal, page.id)
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'message' and e.aggregate_id = m.id
                      and e.type = 'message.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                      and e.type = 'thread.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'project' and e.aggregate_id = p.id
                      and e.type = 'project.created' and e.cursor > $2
                  )
                order by m.thread_id, m.ordinal, m.id limit 1
             ) next_message
            where page.page_count < $6
              and page.cumulative_wire_bytes + next_message.conservative_wire_bytes <= $7
         )
         select id, organization_id, project_id, thread_id, ordinal, author_user_id,
                body, version, created_at, updated_at, cumulative_wire_bytes
           from page order by thread_id, ordinal, id`,
        [
          request.organizationId,
          requestedHead.toString(),
          messageAfter?.threadId ?? "",
          messageAfter?.ordinal ?? "0",
          messageAfter?.id ?? "",
        ],
        messageFromRow,
        async (row) =>
          Boolean(
            (
              await queryOne<QueryResultRow>(
                client,
                `select exists (
                   select 1 from messages m
                   join threads t on t.id = m.thread_id and t.organization_id = m.organization_id
                   join projects p on p.id = t.project_id and p.organization_id = t.organization_id
                    where m.organization_id = $1 and m.deleted_at is null
                      and t.archived_at is null and p.archived_at is null
                      and (m.thread_id, m.ordinal, m.id) > ($3, $4, $5)
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'message' and e.aggregate_id = m.id
                          and e.type = 'message.created' and e.cursor > $2
                      )
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                          and e.type = 'thread.created' and e.cursor > $2
                      )
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'project' and e.aggregate_id = p.id
                          and e.type = 'project.created' and e.cursor > $2
                      )
                 ) as value`,
                [
                  request.organizationId,
                  requestedHead.toString(),
                  row?.thread_id ?? messageAfter?.threadId ?? "",
                  row?.ordinal ?? messageAfter?.ordinal ?? "0",
                  row?.id ?? messageAfter?.id ?? "",
                ],
              )
            )?.value,
          ),
      );
      await runSection(
        "artifact",
        `with recursive page as (
           select first_artifact.*, 1::integer as page_count,
                  first_artifact.conservative_wire_bytes as cumulative_wire_bytes
             from lateral (
               select a.id, a.organization_id, a.project_id, a.thread_id, a.kind, a.title,
                      a.icon, a.body, a.version, a.created_at, a.updated_at,
                      (octet_length(a.id) + octet_length(a.project_id)
                        + octet_length(coalesce(a.thread_id, '')) + octet_length(a.kind)
                        + octet_length(a.title) + octet_length(coalesce(a.icon, ''))
                        + octet_length(coalesce(a.body::text, '')) + 2048)::bigint
                        as conservative_wire_bytes
                 from artifacts a
                 join projects p on p.id = a.project_id and p.organization_id = a.organization_id
                 left join threads t
                   on t.id = a.thread_id and t.organization_id = a.organization_id
                  and t.project_id = a.project_id
                where a.organization_id = $1 and a.archived_at is null and p.archived_at is null
                  and (a.thread_id is null or (t.id is not null and t.archived_at is null))
                  and a.id > $3
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'artifact' and e.aggregate_id = a.id
                      and e.type = 'artifact.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'project' and e.aggregate_id = p.id
                      and e.type = 'project.created' and e.cursor > $2
                  )
                  and (a.thread_id is null or not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                      and e.type = 'thread.created' and e.cursor > $2
                  ))
                order by a.id limit 1
             ) first_artifact
            where first_artifact.conservative_wire_bytes <= $5
           union all
           select next_artifact.*, page.page_count + 1,
                  page.cumulative_wire_bytes + next_artifact.conservative_wire_bytes
             from page
             cross join lateral (
               select a.id, a.organization_id, a.project_id, a.thread_id, a.kind, a.title,
                      a.icon, a.body, a.version, a.created_at, a.updated_at,
                      (octet_length(a.id) + octet_length(a.project_id)
                        + octet_length(coalesce(a.thread_id, '')) + octet_length(a.kind)
                        + octet_length(a.title) + octet_length(coalesce(a.icon, ''))
                        + octet_length(coalesce(a.body::text, '')) + 2048)::bigint
                        as conservative_wire_bytes
                 from artifacts a
                 join projects p on p.id = a.project_id and p.organization_id = a.organization_id
                 left join threads t
                   on t.id = a.thread_id and t.organization_id = a.organization_id
                  and t.project_id = a.project_id
                where a.organization_id = $1 and a.archived_at is null and p.archived_at is null
                  and (a.thread_id is null or (t.id is not null and t.archived_at is null))
                  and a.id > page.id
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'artifact' and e.aggregate_id = a.id
                      and e.type = 'artifact.created' and e.cursor > $2
                  )
                  and not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'project' and e.aggregate_id = p.id
                      and e.type = 'project.created' and e.cursor > $2
                  )
                  and (a.thread_id is null or not exists (
                    select 1 from product_events e where e.organization_id = $1
                      and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                      and e.type = 'thread.created' and e.cursor > $2
                  ))
                order by a.id limit 1
             ) next_artifact
            where page.page_count < $4
              and page.cumulative_wire_bytes + next_artifact.conservative_wire_bytes <= $5
         )
         select id, organization_id, project_id, thread_id, kind, title, icon, body,
                version, created_at, updated_at, cumulative_wire_bytes
           from page order by id`,
        [request.organizationId, requestedHead.toString(), simpleAfter("artifact")],
        artifactFromRow,
        async (row) =>
          Boolean(
            (
              await queryOne<QueryResultRow>(
                client,
                `select exists (
                   select 1 from artifacts a
                   join projects p on p.id = a.project_id and p.organization_id = a.organization_id
                   left join threads t on t.id = a.thread_id
                     and t.organization_id = a.organization_id and t.project_id = a.project_id
                    where a.organization_id = $1 and a.archived_at is null and p.archived_at is null
                      and (a.thread_id is null or (t.id is not null and t.archived_at is null))
                      and a.id > $3
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'artifact' and e.aggregate_id = a.id
                          and e.type = 'artifact.created' and e.cursor > $2
                      )
                      and not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'project' and e.aggregate_id = p.id
                          and e.type = 'project.created' and e.cursor > $2
                      )
                      and (a.thread_id is null or not exists (
                        select 1 from product_events e where e.organization_id = $1
                          and e.aggregate_type = 'thread' and e.aggregate_id = t.id
                          and e.type = 'thread.created' and e.cursor > $2
                      ))
                 ) as value`,
                [
                  request.organizationId,
                  requestedHead.toString(),
                  row?.id ?? simpleAfter("artifact"),
                ],
              )
            )?.value,
          ),
      );

      let emitted = entities.slice(0, request.limit);
      const positionOf = (item: SnapshotEntity): SnapshotPosition =>
        item.section === "organization-member"
          ? { section: item.section, id: (item.entity as OrganizationMember).userId }
          : item.section === "message"
            ? {
                section: item.section,
                id: (item.entity as Message).id,
                threadId: (item.entity as Message).threadId,
                ordinal: (item.entity as Message).ordinal,
              }
            : { section: item.section, id: (item.entity as Project | Thread | Artifact).id };
      const responseFor = (pageEntities: readonly SnapshotEntity[], hasMore: boolean) => ({
        organization,
        head,
        entities: pageEntities,
        hasMore,
        next: hasMore && pageEntities.length > 0 ? positionOf(pageEntities.at(-1)!) : null,
      });
      let hasMore = moreInDatabase || entities.length > emitted.length;
      let response = responseFor(emitted, hasMore);
      while (
        emitted.length > 0 &&
        new TextEncoder().encode(JSON.stringify(response)).byteLength > maxSnapshotResponseBytes
      ) {
        emitted = emitted.slice(0, -1);
        hasMore = true;
        response = responseFor(emitted, true);
      }
      if (hasMore && emitted.length === 0) {
        throw new ProductFailure("invalid", "A product entity exceeds the snapshot byte boundary.");
      }
      const decoded = decodeSnapshotPageResponse(response, request);
      if (!decoded.ok) {
        throw new ProductFailure("invalid", "The database produced an invalid snapshot page.");
      }
      return decoded.value;
    }),
});
