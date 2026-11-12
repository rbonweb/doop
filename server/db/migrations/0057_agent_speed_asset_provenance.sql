ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "source" jsonb;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "tags" text[];
