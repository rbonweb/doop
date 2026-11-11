CREATE TABLE IF NOT EXISTS "agent_defaults" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_accounts" DROP CONSTRAINT IF EXISTS "model_accounts_pkey";--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_accounts_user_id_kind_pk') THEN
		ALTER TABLE "model_accounts" ADD CONSTRAINT "model_accounts_user_id_kind_pk" PRIMARY KEY("user_id","kind");
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
