CREATE TYPE "public"."environment_security_event_type" AS ENUM('pairing-requested', 'pairing-approved', 'pairing-completed', 'credential-issued', 'key-rotated', 'environment-revoked');--> statement-breakpoint
CREATE TYPE "public"."execution_operation_status" AS ENUM('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "environment_security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"environment_id" text,
	"type" "environment_security_event_type" NOT NULL,
	"actor_user_id" text,
	"correlation_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_security_events_metadata_check" CHECK (jsonb_typeof("environment_security_events"."metadata") = 'object' and octet_length("environment_security_events"."metadata"::text) <= 4096 and not ("environment_security_events"."metadata" ?| array['token', 'secret', 'challenge', 'signature', 'publicKey', 'public_key', 'pairingCode', 'pairing_code', 'pollingToken', 'polling_token']))
);
--> statement-breakpoint
CREATE TABLE "execution_operation_events" (
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_operation_events_operation_id_sequence_pk" PRIMARY KEY("operation_id","sequence"),
	CONSTRAINT "execution_operation_events_sequence_check" CHECK ("execution_operation_events"."sequence" >= 0 and "execution_operation_events"."sequence" < 2048),
	CONSTRAINT "execution_operation_events_kind_check" CHECK ("execution_operation_events"."event" in ('progress', 'result', 'error')),
	CONSTRAINT "execution_operation_events_payload_size_check" CHECK (octet_length("execution_operation_events"."payload"::text) <= 131072)
);
--> statement-breakpoint
CREATE TABLE "execution_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"capability" text NOT NULL,
	"operation" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" "execution_operation_status" DEFAULT 'queued' NOT NULL,
	"last_sequence" integer DEFAULT -1 NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_operations_actor_request_unique" UNIQUE("organization_id","actor_user_id","request_id"),
	CONSTRAINT "execution_operations_request_size_check" CHECK (octet_length("execution_operations"."request"::text) <= 1048576),
	CONSTRAINT "execution_operations_result_size_check" CHECK ("execution_operations"."result" is null or octet_length("execution_operations"."result"::text) <= 1048576),
	CONSTRAINT "execution_operations_error_size_check" CHECK ("execution_operations"."error" is null or octet_length("execution_operations"."error"::text) <= 16384),
	CONSTRAINT "execution_operations_sequence_check" CHECK ("execution_operations"."last_sequence" >= -1 and "execution_operations"."last_sequence" < 2048)
);
--> statement-breakpoint
CREATE TABLE "workspace_bindings" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_bindings_environment_id_id_pk" PRIMARY KEY("environment_id","id"),
	CONSTRAINT "workspace_bindings_scope_unique" UNIQUE("organization_id","project_id","environment_id","id")
);
--> statement-breakpoint
ALTER TABLE "environment_security_events" ADD CONSTRAINT "environment_security_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_security_events" ADD CONSTRAINT "environment_security_events_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_security_events" ADD CONSTRAINT "environment_security_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operation_events" ADD CONSTRAINT "execution_operation_events_operation_id_execution_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."execution_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD CONSTRAINT "execution_operations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD CONSTRAINT "execution_operations_workspace_binding_fk" FOREIGN KEY ("organization_id","project_id","environment_id","workspace_id") REFERENCES "public"."workspace_bindings"("organization_id","project_id","environment_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_bindings" ADD CONSTRAINT "workspace_bindings_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_bindings" ADD CONSTRAINT "workspace_bindings_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_bindings" ADD CONSTRAINT "workspace_bindings_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "public"."execution_environments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_security_events_environment_time_idx" ON "environment_security_events" USING btree ("environment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "environment_security_events_organization_time_idx" ON "environment_security_events" USING btree ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "execution_operations_scope_created_idx" ON "execution_operations" USING btree ("organization_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_bindings_project_active_idx" ON "workspace_bindings" USING btree ("organization_id","project_id","revoked_at");