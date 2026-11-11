ALTER TABLE "model_accounts" ADD COLUMN IF NOT EXISTS "custom" jsonb;--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN IF NOT EXISTS "custom_headers" text;