CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"colour" text NOT NULL,
	"surface" text NOT NULL,
	"eye_colour" text NOT NULL,
	"tone" text NOT NULL,
	"standing_instruction" text NOT NULL,
	"allowed_connection_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asks_before_acting" boolean DEFAULT true NOT NULL,
	"face_image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_draft_send" (
	"draft_action_id" text PRIMARY KEY NOT NULL,
	"send_action_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discarded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experience_profile" (
	"space_id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"day_start" text DEFAULT '08:00' NOT NULL,
	"day_end" text DEFAULT '22:00' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"tool_kind" text NOT NULL,
	"recipient" jsonb NOT NULL,
	"recipient_class" text NOT NULL,
	"origin_trust" text NOT NULL,
	"count_cap" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reconsent_after_days" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_rule_bounds" CHECK ("experience_rule"."count_cap" between 1 and 100 and "experience_rule"."reconsent_after_days" between 1 and 30 and "experience_rule"."used" between 0 and "experience_rule"."count_cap")
);
--> statement-breakpoint
CREATE TABLE "experience_rule_use" (
	"action_id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience_turn" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"text" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "experience_turn_submission_id_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "experience_undo" (
	"action_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"reversal_action_id" text,
	CONSTRAINT "experience_undo_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "plan_milestone" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"title" text NOT NULL,
	"ordinal" integer NOT NULL,
	"agent_id" text,
	"child_job_id" text,
	"done" boolean DEFAULT false NOT NULL,
	"schedule_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "kind" text DEFAULT 'responsibility' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "current_turn_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "plan_id" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "pause_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "options" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "space_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_draft_send" ADD CONSTRAINT "experience_draft_send_draft_action_id_action_id_fk" FOREIGN KEY ("draft_action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_draft_send" ADD CONSTRAINT "experience_draft_send_send_action_id_action_id_fk" FOREIGN KEY ("send_action_id") REFERENCES "public"."action"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_profile" ADD CONSTRAINT "experience_profile_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD CONSTRAINT "experience_rule_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_rule" ADD CONSTRAINT "experience_rule_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_rule_use" ADD CONSTRAINT "experience_rule_use_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_rule_use" ADD CONSTRAINT "experience_rule_use_rule_id_experience_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."experience_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_turn" ADD CONSTRAINT "experience_turn_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_turn" ADD CONSTRAINT "experience_turn_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_undo" ADD CONSTRAINT "experience_undo_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience_undo" ADD CONSTRAINT "experience_undo_reversal_action_id_action_id_fk" FOREIGN KEY ("reversal_action_id") REFERENCES "public"."action"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_milestone" ADD CONSTRAINT "plan_milestone_plan_id_job_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_milestone" ADD CONSTRAINT "plan_milestone_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_milestone" ADD CONSTRAINT "plan_milestone_child_job_id_job_id_fk" FOREIGN KEY ("child_job_id") REFERENCES "public"."job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;