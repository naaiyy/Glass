CREATE TYPE "public"."organization_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"icon" text,
	"body" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "artifacts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" in ('agent-output', 'note')),
	CONSTRAINT "artifacts_body_kind_check" CHECK (("artifacts"."kind" = 'agent-output' and "artifacts"."body" is not null and "artifacts"."icon" is null and octet_length("artifacts"."body"::text) <= 2000000) or ("artifacts"."kind" = 'note' and "artifacts"."body" is null and "artifacts"."thread_id" is null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"ordinal" bigint NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_body_size_check" CHECK (octet_length("messages"."body") <= 1000000)
);
--> statement-breakpoint
CREATE TABLE "mutation_receipts" (
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"command_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"cursor" bigint NOT NULL,
	"result" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_receipts_organization_id_actor_user_id_command_id_pk" PRIMARY KEY("organization_id","actor_user_id","command_id"),
	CONSTRAINT "mutation_receipts_positive_cursor_check" CHECK ("mutation_receipts"."cursor" > 0)
);
--> statement-breakpoint
CREATE TABLE "note_contents" (
	"organization_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by_user_id" text NOT NULL,
	CONSTRAINT "note_contents_organization_id_artifact_id_pk" PRIMARY KEY("organization_id","artifact_id"),
	CONSTRAINT "note_contents_content_size_check" CHECK (octet_length("note_contents"."content"::text) <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "organization_role" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organization_sync_state" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"retention_floor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_sync_state_cursor_range_check" CHECK ("organization_sync_state"."retention_floor" >= 0 and "organization_sync_state"."cursor" >= "organization_sync_state"."retention_floor")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"cursor" bigint NOT NULL,
	"command_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_version" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_events_organization_cursor_unique" UNIQUE("organization_id","cursor"),
	CONSTRAINT "product_events_positive_cursor_version_check" CHECK ("product_events"."cursor" > 0 and "product_events"."aggregate_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text,
	"version" integer DEFAULT 1 NOT NULL,
	"next_message_ordinal" bigint DEFAULT 1 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "threads_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "threads_organization_project_id_unique" UNIQUE("organization_id","project_id","id")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_project_thread_fk" FOREIGN KEY ("organization_id","project_id","thread_id") REFERENCES "public"."threads"("organization_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_thread_fk" FOREIGN KEY ("organization_id","thread_id") REFERENCES "public"."threads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_contents" ADD CONSTRAINT "note_contents_saved_by_user_id_user_id_fk" FOREIGN KEY ("saved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_contents" ADD CONSTRAINT "note_contents_organization_artifact_fk" FOREIGN KEY ("organization_id","artifact_id") REFERENCES "public"."artifacts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_sync_state" ADD CONSTRAINT "organization_sync_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_project_updated_idx" ON "artifacts" USING btree ("organization_id","project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_thread_ordinal_unique" ON "messages" USING btree ("organization_id","thread_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_organization_id_id_unique" ON "messages" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "mutation_receipts_actor_accepted_idx" ON "mutation_receipts" USING btree ("organization_id","actor_user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "organization_members_user_active_idx" ON "organization_members" USING btree ("user_id","removed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_events_aggregate_version_unique" ON "product_events" USING btree ("organization_id","aggregate_type","aggregate_id","aggregate_version");--> statement-breakpoint
CREATE INDEX "product_events_organization_type_cursor_idx" ON "product_events" USING btree ("organization_id","type","cursor");--> statement-breakpoint
CREATE INDEX "projects_organization_updated_idx" ON "projects" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "threads_project_updated_idx" ON "threads" USING btree ("organization_id","project_id","updated_at");