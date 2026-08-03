CREATE TYPE "public"."managed_tunnel_status" AS ENUM('provisioning', 'active', 'cleanup_pending', 'revoked');--> statement-breakpoint
CREATE TABLE "connect_client_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"session_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"client_nonce" text NOT NULL,
	"tunnel_generation" integer NOT NULL,
	"key_version" integer NOT NULL,
	"hostname" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"session_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_client_tickets_ticket_id_unique" UNIQUE("ticket_id"),
	CONSTRAINT "connect_client_tickets_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "connect_client_tickets_channel_id_unique" UNIQUE("channel_id"),
	CONSTRAINT "connect_client_tickets_generation_check" CHECK ("connect_client_tickets"."tunnel_generation" > 0 and "connect_client_tickets"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "execution_environment_presence" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_environment_presence_status_check" CHECK ("execution_environment_presence"."status" in ('online','offline')),
	CONSTRAINT "execution_environment_presence_payload_check" CHECK (jsonb_typeof("execution_environment_presence"."capabilities") = 'array' and jsonb_array_length("execution_environment_presence"."capabilities") <= 32 and jsonb_typeof("execution_environment_presence"."workspaces") = 'array' and jsonb_array_length("execution_environment_presence"."workspaces") <= 512 and octet_length("execution_environment_presence"."workspaces"::text) <= 131072)
);
--> statement-breakpoint
CREATE TABLE "managed_environment_tunnels" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider_ownership_id" text NOT NULL,
	"tunnel_id" text,
	"dns_record_id" text,
	"hostname" text NOT NULL,
	"local_origin" text NOT NULL,
	"status" "managed_tunnel_status" NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "managed_environment_tunnels_provider_ownership_id_unique" UNIQUE("provider_ownership_id"),
	CONSTRAINT "managed_environment_tunnels_tunnel_id_unique" UNIQUE("tunnel_id"),
	CONSTRAINT "managed_environment_tunnels_dns_record_id_unique" UNIQUE("dns_record_id"),
	CONSTRAINT "managed_environment_tunnels_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "managed_environment_tunnels_origin_check" CHECK ("managed_environment_tunnels"."local_origin" ~ '^http://127\.0\.0\.1:([1-9][0-9]{0,4})$'),
	CONSTRAINT "managed_environment_tunnels_generation_check" CHECK ("managed_environment_tunnels"."generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "execution_operations" ADD COLUMN "dispatch_channel_id" text;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD COLUMN "dispatch_session_id" text;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connect_client_tickets" ADD CONSTRAINT "connect_client_tickets_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_client_tickets" ADD CONSTRAINT "connect_client_tickets_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_client_tickets" ADD CONSTRAINT "connect_client_tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_client_tickets" ADD CONSTRAINT "connect_client_tickets_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "public"."execution_environments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environment_presence" ADD CONSTRAINT "execution_environment_presence_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environment_presence" ADD CONSTRAINT "execution_environment_presence_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "public"."execution_environments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_environment_tunnels" ADD CONSTRAINT "managed_environment_tunnels_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_environment_tunnels" ADD CONSTRAINT "managed_environment_tunnels_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "public"."execution_environments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_client_tickets_expiry_idx" ON "connect_client_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connect_client_tickets_session_expiry_idx" ON "connect_client_tickets" USING btree ("session_expires_at");--> statement-breakpoint
CREATE INDEX "managed_environment_tunnels_organization_status_idx" ON "managed_environment_tunnels" USING btree ("organization_id","status");