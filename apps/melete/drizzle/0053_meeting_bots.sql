CREATE TABLE "meeting_bot" (
	"action_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"meeting_url" text NOT NULL,
	"bot_name" text NOT NULL,
	"join_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"artifact_id" text,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "meeting_bot_status_check" CHECK ("meeting_bot"."status" in ('scheduled', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "meeting_bot" ADD CONSTRAINT "meeting_bot_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bot" ADD CONSTRAINT "meeting_bot_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bot" ADD CONSTRAINT "meeting_bot_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bot" ADD CONSTRAINT "meeting_bot_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_bot_bot_idx" ON "meeting_bot" USING btree ("connection_id","bot_id");--> statement-breakpoint
CREATE INDEX "meeting_bot_due_idx" ON "meeting_bot" USING btree ("status","next_check_at");