CREATE TABLE IF NOT EXISTS "component_propagation_queue" (
	"frame_id" text NOT NULL,
	"task" text NOT NULL,
	"canvas_id" text NOT NULL,
	"component_ids" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"queued_at" bigint NOT NULL,
	CONSTRAINT "component_propagation_queue_frame_id_task_pk" PRIMARY KEY("frame_id","task")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "component_propagation_queue_canvas_idx" ON "component_propagation_queue" USING btree ("canvas_id");