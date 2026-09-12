CREATE TABLE "repair_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"job_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"fault_kind" text NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"observed_schema" jsonb,
	"proposed_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test" jsonb NOT NULL,
	"evaluation" jsonb,
	"safe" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "repair_trace" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "repair_counters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "repair_disposition" text;--> statement-breakpoint
ALTER TABLE "action" ADD COLUMN "retry_after_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repair_candidate" ADD CONSTRAINT "repair_candidate_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_candidate" ADD CONSTRAINT "repair_candidate_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repair_candidate_action_idx" ON "repair_candidate" USING btree ("action_id","state");--> statement-breakpoint
CREATE INDEX "repair_candidate_job_idx" ON "repair_candidate" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repair_candidate_mapping_idx" ON "repair_candidate" USING btree ("action_id","proposed_mapping");