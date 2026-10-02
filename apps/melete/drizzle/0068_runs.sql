CREATE TABLE "run_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"run_job_id" text NOT NULL,
	"step_job_id" text,
	"attempt_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_state" (
	"job_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"parent_run_id" text,
	"conversation_id" text,
	"goal" text NOT NULL,
	"done_when" text,
	"metric" jsonb,
	"limit" jsonb,
	"shifts" integer DEFAULT 0 NOT NULL,
	"idle_shifts" integer DEFAULT 0 NOT NULL,
	"waiting_on_steps" boolean DEFAULT false NOT NULL,
	"last_report_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_entry" ADD CONSTRAINT "run_entry_run_job_id_job_id_fk" FOREIGN KEY ("run_job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_entry" ADD CONSTRAINT "run_entry_step_job_id_job_id_fk" FOREIGN KEY ("step_job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_state" ADD CONSTRAINT "run_state_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_state" ADD CONSTRAINT "run_state_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_state" ADD CONSTRAINT "run_state_parent_run_id_job_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_state" ADD CONSTRAINT "run_state_conversation_id_job_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_entry_run_seq_idx" ON "run_entry" USING btree ("run_job_id","seq");--> statement-breakpoint
CREATE INDEX "run_entry_attempt_idx" ON "run_entry" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "run_state_parent_idx" ON "run_state" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "run_state_conversation_idx" ON "run_state" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "run_state_space_idx" ON "run_state" USING btree ("space_id");