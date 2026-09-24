ALTER TABLE "experience_rule" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD COLUMN "source_action_id" text;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD CONSTRAINT "experience_rule_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD CONSTRAINT "experience_rule_source_action_id_action_id_fk" FOREIGN KEY ("source_action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experience_rule_job_idx" ON "experience_rule" USING btree ("job_id") WHERE "experience_rule"."job_id" is not null;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD CONSTRAINT "experience_rule_job_scope" CHECK ("experience_rule"."origin_trust" <> 'person_approved' or ("experience_rule"."job_id" is not null and "experience_rule"."source_action_id" is not null));