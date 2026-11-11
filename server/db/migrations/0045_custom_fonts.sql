CREATE TABLE IF NOT EXISTS "fonts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"owner_id" text,
	"family" text NOT NULL,
	"weight" text NOT NULL,
	"style" text NOT NULL,
	"format" text NOT NULL,
	"asset_id" text NOT NULL,
	"ext" text NOT NULL,
	"file_name" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fonts_workspace_idx" ON "fonts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fonts_owner_idx" ON "fonts" USING btree ("owner_id");