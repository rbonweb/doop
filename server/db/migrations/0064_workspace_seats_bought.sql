ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "seats_bought" integer DEFAULT 1 NOT NULL;
