CREATE TABLE "acceptance_journal" (
	"submission_id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"receipt" jsonb NOT NULL,
	"receipt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission" (
	"submission_id" text PRIMARY KEY NOT NULL,
	"input_digest" text NOT NULL,
	"job_id" text,
	"job_revision" integer,
	"event_cursor" bigint,
	"state" text NOT NULL,
	"http_status" integer NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acceptance_journal" ADD CONSTRAINT "acceptance_journal_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;