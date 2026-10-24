-- Upstream's frame history table. A database that already ran this fork's 0028 has frame_versions with name and reason, so every statement here tolerates an existing table and index.
CREATE TABLE IF NOT EXISTS "frame_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"frame_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"html" text NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"saved_at" bigint NOT NULL,
	"saved_by" text NOT NULL,
	"saved_by_kind" text
);
--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN IF NOT EXISTS "saved_by_kind" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_versions_frame_idx" ON "frame_versions" USING btree ("frame_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_versions_canvas_idx" ON "frame_versions" USING btree ("canvas_id");
