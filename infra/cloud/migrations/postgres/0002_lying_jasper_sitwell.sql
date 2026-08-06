CREATE TYPE "public"."environment_challenge_purpose" AS ENUM('pair', 'credential', 'rotate');--> statement-breakpoint
CREATE TABLE "environment_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"issued_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_credentials_key_version_check" CHECK ("environment_credentials"."issued_key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "environment_identity_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"environment_id" text,
	"purpose" "environment_challenge_purpose" NOT NULL,
	"challenge" text,
	"pairing_code_hash" text,
	"polling_token_hash" text,
	"verification_public_key" text NOT NULL,
	"requested_public_key" text,
	"display_name" text,
	"platform" text,
	"requested_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_identity_challenges_shape_check" CHECK (("environment_identity_challenges"."purpose" = 'pair' and "environment_identity_challenges"."environment_id" is null and "environment_identity_challenges"."requested_public_key" is not null and "environment_identity_challenges"."display_name" is not null and "environment_identity_challenges"."platform" is not null and "environment_identity_challenges"."pairing_code_hash" is not null and "environment_identity_challenges"."polling_token_hash" is not null) or ("environment_identity_challenges"."purpose" = 'credential' and "environment_identity_challenges"."organization_id" is not null and "environment_identity_challenges"."environment_id" is not null and "environment_identity_challenges"."challenge" is not null and "environment_identity_challenges"."requested_by_user_id" is null and "environment_identity_challenges"."requested_public_key" is null and "environment_identity_challenges"."display_name" is null and "environment_identity_challenges"."platform" is null) or ("environment_identity_challenges"."purpose" = 'rotate' and "environment_identity_challenges"."organization_id" is not null and "environment_identity_challenges"."environment_id" is not null and "environment_identity_challenges"."challenge" is not null and "environment_identity_challenges"."requested_by_user_id" is not null and "environment_identity_challenges"."requested_public_key" is not null and "environment_identity_challenges"."display_name" is null and "environment_identity_challenges"."platform" is null))
);
--> statement-breakpoint
CREATE TABLE "execution_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"public_key" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "execution_environments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "execution_environments_platform_check" CHECK ("execution_environments"."platform" in ('linux', 'macos', 'windows')),
	CONSTRAINT "execution_environments_key_version_check" CHECK ("execution_environments"."key_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "environment_credentials" ADD CONSTRAINT "environment_credentials_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_credentials" ADD CONSTRAINT "environment_credentials_organization_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "public"."execution_environments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_identity_challenges" ADD CONSTRAINT "environment_identity_challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_identity_challenges" ADD CONSTRAINT "environment_identity_challenges_environment_id_execution_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."execution_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_identity_challenges" ADD CONSTRAINT "environment_identity_challenges_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD CONSTRAINT "execution_environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_environments" ADD CONSTRAINT "execution_environments_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_credentials_secret_hash_unique" ON "environment_credentials" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "environment_credentials_environment_expiry_idx" ON "environment_credentials" USING btree ("environment_id","expires_at");--> statement-breakpoint
CREATE INDEX "environment_identity_challenges_expiry_idx" ON "environment_identity_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_identity_challenges_pairing_code_unique" ON "environment_identity_challenges" USING btree ("pairing_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_environments_public_key_unique" ON "execution_environments" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "execution_environments_organization_active_idx" ON "execution_environments" USING btree ("organization_id","revoked_at","id");