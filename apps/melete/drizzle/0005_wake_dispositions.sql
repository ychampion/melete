CREATE TABLE "background_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"kind" text NOT NULL,
	"substrate_disposition" text NOT NULL,
	"state" text DEFAULT 'registered' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"owner_instance" text,
	"lease_expires_at" timestamp with time zone,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"remote_ref" text,
	"trigger_id" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "substrate_disposition" text DEFAULT 'timer_or_event' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "substrate_disposition" text DEFAULT 'local_process_interrupted' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "substrate_disposition" text DEFAULT 'timer_or_event' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "substrate_disposition" text DEFAULT 'external_uncertain' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_obligation" ADD COLUMN "substrate_disposition" text DEFAULT 'timer_or_event' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "substrate_disposition" text DEFAULT 'timer_or_event' NOT NULL;--> statement-breakpoint
ALTER TABLE "background_operation" ADD CONSTRAINT "background_operation_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_operation" ADD CONSTRAINT "background_operation_trigger_id_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operation_job_key_idx" ON "background_operation" USING btree ("job_id","operation_key");--> statement-breakpoint
CREATE INDEX "operation_ready_idx" ON "background_operation" USING btree ("state","due_at");