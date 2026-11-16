ALTER TABLE "components" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN IF NOT EXISTS "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN IF NOT EXISTS "deleted_by" text;