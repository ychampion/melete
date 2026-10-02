ALTER TABLE "run_state" ADD COLUMN "check_result" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "run_state" ADD COLUMN "checking" text;