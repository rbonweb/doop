-- Reconciles this fork's 0028/0029 with upstream's 0030-0035 (renumbered so they run after the fork's on a database that already applied it). Everything here already exists on a database that ran the fork's 0028, so every statement tolerates it; on a fresh database the fork's 0028 created them first and this is a no-op except for the frame_versions fix-ups at the end. frame_versions_frame_idx is dropped and recreated because the two histories defined it on different columns.
CREATE TABLE IF NOT EXISTS "canvas_access_requests" (
	"canvas_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message" text,
	"at" bigint NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "canvas_access_requests_canvas_id_user_id_pk" PRIMARY KEY("canvas_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvas_domain_grants" (
	"canvas_id" text NOT NULL,
	"domain" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" bigint NOT NULL,
	CONSTRAINT "canvas_domain_grants_canvas_id_domain_pk" PRIMARY KEY("canvas_id","domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvas_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text,
	"frame_id" text,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"markdown" text NOT NULL,
	"color" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvas_visits" (
	"user_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"baseline_at" bigint NOT NULL,
	CONSTRAINT "canvas_visits_user_id_canvas_id_pk" PRIMARY KEY("user_id","canvas_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "frame_seen" (
	"user_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"seen_updated_at" bigint NOT NULL,
	CONSTRAINT "frame_seen_user_id_frame_id_pk" PRIMARY KEY("user_id","frame_id")
);
--> statement-breakpoint
DROP INDEX IF EXISTS "frame_versions_frame_idx";--> statement-breakpoint
ALTER TABLE "canvas_members" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'edit' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN IF NOT EXISTS "link_audience" text;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN IF NOT EXISTS "link_password_hash" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "from_kind" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "mentions" text;--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "content_updated_at" bigint;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "updated_by_kind" text;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "slide" boolean;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "speaker_notes" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvas_notes_canvas_idx" ON "canvas_notes" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_seen_user_canvas_idx" ON "frame_seen" USING btree ("user_id","canvas_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frame_versions_frame_idx" ON "frame_versions" USING btree ("frame_id","saved_at");
--> statement-breakpoint
ALTER TABLE "frame_versions" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "frame_versions" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
UPDATE "frame_versions" SET "saved_by_kind" = CASE "reason" WHEN 'agent' THEN 'agent' WHEN 'human' THEN 'user' END WHERE "saved_by_kind" IS NULL AND "reason" IN ('agent', 'human');
