CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"coalesce_key" text NOT NULL,
	"delivery_key" text NOT NULL,
	"obligation_ids" jsonb NOT NULL,
	"content" jsonb,
	"content_hash" text NOT NULL,
	"delivery_attempt" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_obligation" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'owed' NOT NULL,
	"coalesce_key" text NOT NULL,
	"event_cursor" bigint NOT NULL,
	"content" jsonb,
	"content_hash" text,
	"acknowledged_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_obligation_submission_id_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_obligation" ADD CONSTRAINT "reply_obligation_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempt_idx" ON "notification" USING btree ("delivery_key","delivery_attempt");--> statement-breakpoint
CREATE INDEX "notification_pending_idx" ON "notification" USING btree ("state");--> statement-breakpoint
CREATE INDEX "reply_owed_idx" ON "reply_obligation" USING btree ("state","job_id");