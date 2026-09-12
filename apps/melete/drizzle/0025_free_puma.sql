CREATE TABLE "learning_trial" (
	"job_id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"use_candidate" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_trial" ADD CONSTRAINT "learning_trial_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_trial" ADD CONSTRAINT "learning_trial_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_trial" ADD CONSTRAINT "learning_trial_evaluation_id_procedure_evaluation_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."procedure_evaluation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_evaluation_once_idx" ON "procedure_evaluation" USING btree ("candidate_id","body_hash","phase");