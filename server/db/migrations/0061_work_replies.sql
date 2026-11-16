ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "reply" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reply" text;