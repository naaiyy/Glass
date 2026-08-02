import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.generated.ts";

export * from "./auth-schema.generated.ts";

export const organizationRole = pgEnum("organization_role", ["owner", "admin", "member"]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  version: integer("version").default(1).notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: organizationRole("role").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_active_idx").on(table.userId, table.removedAt),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").default(1).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.organizationId, table.id),
    index("projects_organization_updated_idx").on(table.organizationId, table.updatedAt),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title"),
    version: integer("version").default(1).notNull(),
    nextMessageOrdinal: bigint("next_message_ordinal", { mode: "number" })
      .default(sql`1`)
      .notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.organizationId, table.id),
    unique("threads_organization_project_id_unique").on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "threads_organization_project_fk",
    }).onDelete("cascade"),
    index("threads_project_updated_idx").on(table.organizationId, table.projectId, table.updatedAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    threadId: text("thread_id").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.threadId],
      foreignColumns: [threads.organizationId, threads.id],
      name: "messages_organization_thread_fk",
    }).onDelete("cascade"),
    uniqueIndex("messages_thread_ordinal_unique").on(
      table.organizationId,
      table.threadId,
      table.ordinal,
    ),
    uniqueIndex("messages_organization_id_id_unique").on(table.organizationId, table.id),
    check("messages_body_size_check", sql`octet_length(${table.body}) <= 1000000`),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    threadId: text("thread_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    icon: text("icon"),
    body: jsonb("body"),
    version: integer("version").default(1).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "artifacts_organization_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.threadId],
      foreignColumns: [threads.organizationId, threads.projectId, threads.id],
      name: "artifacts_organization_project_thread_fk",
    }).onDelete("restrict"),
    index("artifacts_project_updated_idx").on(
      table.organizationId,
      table.projectId,
      table.updatedAt,
    ),
    check("artifacts_kind_check", sql`${table.kind} in ('agent-output', 'note')`),
    check(
      "artifacts_body_kind_check",
      sql`(${table.kind} = 'agent-output' and ${table.body} is not null and ${table.icon} is null and octet_length(${table.body}::text) <= 2000000) or (${table.kind} = 'note' and ${table.body} is null and ${table.threadId} is null)`,
    ),
  ],
);

export const noteContents = pgTable(
  "note_contents",
  {
    organizationId: text("organization_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    content: jsonb("content").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
    savedByUserId: text("saved_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.artifactId] }),
    foreignKey({
      columns: [table.organizationId, table.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
      name: "note_contents_organization_artifact_fk",
    }).onDelete("cascade"),
    check(
      "note_contents_content_size_check",
      sql`octet_length(${table.content}::text) <= 10485760`,
    ),
  ],
);

export const organizationSyncState = pgTable(
  "organization_sync_state",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursor: bigint("cursor", { mode: "number" })
      .default(sql`0`)
      .notNull(),
    retentionFloor: bigint("retention_floor", { mode: "number" })
      .default(sql`0`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "organization_sync_state_cursor_range_check",
      sql`${table.retentionFloor} >= 0 and ${table.cursor} >= ${table.retentionFloor}`,
    ),
  ],
);

export const productEvents = pgTable(
  "product_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursor: bigint("cursor", { mode: "number" }).notNull(),
    commandId: text("command_id").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("product_events_organization_cursor_unique").on(table.organizationId, table.cursor),
    uniqueIndex("product_events_aggregate_version_unique").on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    index("product_events_organization_type_cursor_idx").on(
      table.organizationId,
      table.type,
      table.cursor,
    ),
    check(
      "product_events_positive_cursor_version_check",
      sql`${table.cursor} > 0 and ${table.aggregateVersion} > 0`,
    ),
  ],
);

export const mutationReceipts = pgTable(
  "mutation_receipts",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    commandId: text("command_id").notNull(),
    requestHash: text("request_hash").notNull(),
    cursor: bigint("cursor", { mode: "number" }).notNull(),
    result: jsonb("result").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.actorUserId, table.commandId] }),
    index("mutation_receipts_actor_accepted_idx").on(
      table.organizationId,
      table.actorUserId,
      table.acceptedAt,
    ),
    check("mutation_receipts_positive_cursor_check", sql`${table.cursor} > 0`),
  ],
);
