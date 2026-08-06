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
export const environmentChallengePurpose = pgEnum("environment_challenge_purpose", [
  "pair",
  "credential",
  "rotate",
]);
export const environmentSecurityEventType = pgEnum("environment_security_event_type", [
  "pairing-requested",
  "pairing-approved",
  "pairing-completed",
  "credential-issued",
  "key-rotation-requested",
  "key-rotation-approved",
  "key-rotated",
  "environment-revoked",
]);

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

export const executionEnvironments = pgTable(
  "execution_environments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    platform: text("platform").notNull(),
    publicKey: text("public_key").notNull(),
    keyVersion: integer("key_version").default(1).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique().on(table.organizationId, table.id),
    uniqueIndex("execution_environments_public_key_unique").on(table.publicKey),
    index("execution_environments_organization_active_idx").on(
      table.organizationId,
      table.revokedAt,
      table.id,
    ),
    check(
      "execution_environments_platform_check",
      sql`${table.platform} in ('linux', 'macos', 'windows')`,
    ),
    check("execution_environments_key_version_check", sql`${table.keyVersion} > 0`),
  ],
);

export const managedTunnelStatus = pgEnum("managed_tunnel_status", [
  "provisioning",
  "active",
  "cleanup_pending",
  "revoked",
]);

export const managedEnvironmentTunnels = pgTable(
  "managed_environment_tunnels",
  {
    environmentId: text("environment_id")
      .primaryKey()
      .references(() => executionEnvironments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    providerOwnershipId: text("provider_ownership_id").notNull().unique(),
    tunnelId: text("tunnel_id").unique(),
    dnsRecordId: text("dns_record_id").unique(),
    hostname: text("hostname").notNull().unique(),
    localOrigin: text("local_origin").notNull(),
    status: managedTunnelStatus("status").notNull(),
    generation: integer("generation").default(1).notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [executionEnvironments.organizationId, executionEnvironments.id],
      name: "managed_environment_tunnels_environment_fk",
    }).onDelete("cascade"),
    index("managed_environment_tunnels_organization_status_idx").on(
      table.organizationId,
      table.status,
    ),
    check(
      "managed_environment_tunnels_origin_check",
      sql`${table.localOrigin} ~ '^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$'`,
    ),
    check("managed_environment_tunnels_generation_check", sql`${table.generation} > 0`),
  ],
);

export const executionEnvironmentPresence = pgTable(
  "execution_environment_presence",
  {
    environmentId: text("environment_id")
      .primaryKey()
      .references(() => executionEnvironments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    status: text("status").notNull(),
    capabilities: jsonb("capabilities").default([]).notNull(),
    workspaces: jsonb("workspaces").default([]).notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [executionEnvironments.organizationId, executionEnvironments.id],
      name: "execution_environment_presence_environment_fk",
    }).onDelete("cascade"),
    check(
      "execution_environment_presence_status_check",
      sql`${table.status} in ('online','offline')`,
    ),
    check(
      "execution_environment_presence_payload_check",
      sql`jsonb_typeof(${table.capabilities}) = 'array' and jsonb_array_length(${table.capabilities}) <= 32 and jsonb_typeof(${table.workspaces}) = 'array' and jsonb_array_length(${table.workspaces}) <= 512 and octet_length(${table.workspaces}::text) <= 131072`,
    ),
  ],
);

export const connectClientTickets = pgTable(
  "connect_client_tickets",
  {
    ticketHash: text("ticket_hash").primaryKey(),
    ticketId: text("ticket_id").notNull().unique(),
    sessionId: text("session_id").notNull().unique(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => executionEnvironments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull().unique(),
    clientNonce: text("client_nonce").notNull(),
    tunnelGeneration: integer("tunnel_generation").notNull(),
    keyVersion: integer("key_version").notNull(),
    hostname: text("hostname").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [executionEnvironments.organizationId, executionEnvironments.id],
      name: "connect_client_tickets_environment_fk",
    }).onDelete("cascade"),
    index("connect_client_tickets_expiry_idx").on(table.expiresAt),
    index("connect_client_tickets_session_expiry_idx").on(table.sessionExpiresAt),
    check(
      "connect_client_tickets_generation_check",
      sql`${table.tunnelGeneration} > 0 and ${table.keyVersion} > 0`,
    ),
  ],
);

export const environmentIdentityChallenges = pgTable(
  "environment_identity_challenges",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    environmentId: text("environment_id").references(() => executionEnvironments.id, {
      onDelete: "cascade",
    }),
    purpose: environmentChallengePurpose("purpose").notNull(),
    challenge: text("challenge"),
    pairingCodeHash: text("pairing_code_hash"),
    pollingTokenHash: text("polling_token_hash"),
    verificationPublicKey: text("verification_public_key").notNull(),
    requestedPublicKey: text("requested_public_key"),
    displayName: text("display_name"),
    platform: text("platform"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("environment_identity_challenges_expiry_idx").on(table.expiresAt),
    check(
      "environment_identity_challenges_shape_check",
      sql`(${table.purpose} = 'pair' and ${table.environmentId} is null and ${table.requestedPublicKey} is not null and ${table.displayName} is not null and ${table.platform} is not null and ${table.pairingCodeHash} is not null and ${table.pollingTokenHash} is not null) or (${table.purpose} = 'credential' and ${table.organizationId} is not null and ${table.environmentId} is not null and ${table.challenge} is not null and ${table.requestedByUserId} is null and ${table.requestedPublicKey} is null and ${table.displayName} is null and ${table.platform} is null) or (${table.purpose} = 'rotate' and ${table.organizationId} is not null and ${table.environmentId} is not null and ${table.requestedPublicKey} is not null and ${table.displayName} is null and ${table.platform} is null and ((${table.pairingCodeHash} is not null and ${table.pollingTokenHash} is not null) or (${table.challenge} is not null and ${table.requestedByUserId} is not null)))`,
    ),
    uniqueIndex("environment_identity_challenges_pairing_code_unique").on(table.pairingCodeHash),
  ],
);

export const environmentCredentials = pgTable(
  "environment_credentials",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => executionEnvironments.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    issuedKeyVersion: integer("issued_key_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [executionEnvironments.organizationId, executionEnvironments.id],
      name: "environment_credentials_organization_environment_fk",
    }).onDelete("cascade"),
    uniqueIndex("environment_credentials_secret_hash_unique").on(table.secretHash),
    index("environment_credentials_environment_expiry_idx").on(
      table.environmentId,
      table.expiresAt,
    ),
    check("environment_credentials_key_version_check", sql`${table.issuedKeyVersion} > 0`),
  ],
);

export const environmentSecurityEvents = pgTable(
  "environment_security_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    environmentId: text("environment_id").references(() => executionEnvironments.id, {
      onDelete: "restrict",
    }),
    type: environmentSecurityEventType("type").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonb("metadata").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("environment_security_events_environment_time_idx").on(
      table.environmentId,
      table.occurredAt,
      table.id,
    ),
    index("environment_security_events_organization_time_idx").on(
      table.organizationId,
      table.occurredAt,
      table.id,
    ),
    check(
      "environment_security_events_metadata_check",
      sql`jsonb_typeof(${table.metadata}) = 'object' and octet_length(${table.metadata}::text) <= 4096 and not (${table.metadata} ?| array['token', 'secret', 'challenge', 'signature', 'publicKey', 'public_key', 'pairingCode', 'pairing_code', 'pollingToken', 'polling_token'])`,
    ),
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

export const executionOperationStatus = pgEnum("execution_operation_status", [
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

export const workspaceBindings = pgTable(
  "workspace_bindings",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    displayName: text("display_name").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.id] }),
    unique("workspace_bindings_scope_unique").on(
      table.organizationId,
      table.projectId,
      table.environmentId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: "workspace_bindings_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.environmentId],
      foreignColumns: [executionEnvironments.organizationId, executionEnvironments.id],
      name: "workspace_bindings_environment_fk",
    }).onDelete("cascade"),
    index("workspace_bindings_project_active_idx").on(
      table.organizationId,
      table.projectId,
      table.revokedAt,
    ),
  ],
);

export const executionOperations = pgTable(
  "execution_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    requestId: text("request_id").notNull(),
    capability: text("capability").notNull(),
    operation: text("operation").notNull(),
    request: jsonb("request").notNull(),
    status: executionOperationStatus("status").default("queued").notNull(),
    lastSequence: integer("last_sequence").default(-1).notNull(),
    dispatchChannelId: text("dispatch_channel_id"),
    dispatchSessionId: text("dispatch_session_id"),
    dispatchClaimedAt: timestamp("dispatch_claimed_at", { withTimezone: true }),
    result: jsonb("result"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId, table.environmentId, table.workspaceId],
      foreignColumns: [
        workspaceBindings.organizationId,
        workspaceBindings.projectId,
        workspaceBindings.environmentId,
        workspaceBindings.id,
      ],
      name: "execution_operations_workspace_binding_fk",
    }).onDelete("restrict"),
    unique("execution_operations_actor_request_unique").on(
      table.organizationId,
      table.actorUserId,
      table.requestId,
    ),
    index("execution_operations_scope_created_idx").on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
    check(
      "execution_operations_request_size_check",
      sql`octet_length(${table.request}::text) <= 1048576`,
    ),
    check(
      "execution_operations_result_size_check",
      sql`${table.result} is null or octet_length(${table.result}::text) <= 1048576`,
    ),
    check(
      "execution_operations_error_size_check",
      sql`${table.error} is null or octet_length(${table.error}::text) <= 16384`,
    ),
    check(
      "execution_operations_sequence_check",
      sql`${table.lastSequence} >= -1 and ${table.lastSequence} < 2048`,
    ),
  ],
);

export const executionOperationEvents = pgTable(
  "execution_operation_events",
  {
    operationId: text("operation_id")
      .notNull()
      .references(() => executionOperations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.sequence] }),
    check(
      "execution_operation_events_sequence_check",
      sql`${table.sequence} >= 0 and ${table.sequence} < 2048`,
    ),
    check(
      "execution_operation_events_kind_check",
      sql`${table.event} in ('progress', 'result', 'error')`,
    ),
    check(
      "execution_operation_events_payload_size_check",
      sql`(${table.event} = 'progress' and octet_length(${table.payload}::text) <= 131072)
        or (${table.event} = 'result' and octet_length(${table.payload}::text) <= 1048576)
        or (${table.event} = 'error' and octet_length(${table.payload}::text) <= 16384)`,
    ),
  ],
);
