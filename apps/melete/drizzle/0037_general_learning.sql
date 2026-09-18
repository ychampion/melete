CREATE TABLE "learning_evaluation_lease" (
	"space_id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "objective_origin" text;--> statement-breakpoint
ALTER TABLE "episode" ADD COLUMN "prior_output" text;--> statement-breakpoint
ALTER TABLE "episode" ADD COLUMN "corrected_output" text;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "triggers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "case_templates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "discrimination" jsonb;--> statement-breakpoint
ALTER TABLE "procedure_evaluation" ADD COLUMN "suite_id" text DEFAULT 'records-fixtures/1' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_model_call" ADD COLUMN "truncation" jsonb;--> statement-breakpoint
ALTER TABLE "learning_model_call" ADD COLUMN "error_detail" text;--> statement-breakpoint
ALTER TABLE "learning_evaluation_lease" ADD CONSTRAINT "learning_evaluation_lease_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_job_scope_idx" ON "learning_job" USING btree ("space_id","template_id");