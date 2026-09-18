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
CREATE INDEX "learning_job_scope_idx" ON "learning_job" USING btree ("space_id","template_id");