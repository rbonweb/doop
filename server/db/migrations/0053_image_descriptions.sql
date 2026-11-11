CREATE TABLE IF NOT EXISTS "image_description_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'account' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "described_at" bigint;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "described_by" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "describe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "describe_payer_id" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "describe_provider" text;
--> statement-breakpoint
-- Do not bill people for images uploaded before descriptions shipped.
UPDATE "assets" SET "describe_attempts" = 3 WHERE "describe_attempts" = 0 AND "described_at" IS NULL;
