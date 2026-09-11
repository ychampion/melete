ALTER TABLE "job" ADD COLUMN "experience_parent_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "experience_command_key" text;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_experience_command_key_unique" UNIQUE("experience_command_key");