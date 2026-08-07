ALTER TABLE "projects" DROP COLUMN "description";--> statement-breakpoint
TRUNCATE TABLE "verification", "user" RESTART IDENTITY CASCADE;
