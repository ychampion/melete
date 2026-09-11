CREATE TABLE "question" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text,
	"text" text NOT NULL,
	"because" jsonb NOT NULL,
	"if_ignored" text NOT NULL,
	"blocks_external_effect" boolean DEFAULT false NOT NULL,
	"deadline_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"answer_submission_id" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_because_not_empty" CHECK (jsonb_array_length("question"."because") > 0)
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "deferred_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "because" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "if_ignored" text DEFAULT 'This message has not been delivered yet.' NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_open_job_idx" ON "question" USING btree ("job_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "question_queue_idx" ON "question" USING btree ("state","blocks_external_effect","deadline_at","created_at");--> statement-breakpoint
UPDATE "notification" SET "because" = jsonb_build_array('job:' || coalesce("job_id", 'unknown')) WHERE jsonb_array_length("because") = 0;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_because_not_empty" CHECK (jsonb_array_length("notification"."because") > 0);