CREATE TABLE "phone_call" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"action_id" text,
	"direction" text NOT NULL,
	"party" text NOT NULL,
	"remote_number" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conversation_id" text,
	"status" text NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"holding" boolean DEFAULT false NOT NULL,
	"question_id" text,
	"outcome" text,
	"follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_seconds" integer,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "phone_call_direction_check" CHECK ("phone_call"."direction" in ('outbound', 'inbound')),
	CONSTRAINT "phone_call_party_check" CHECK ("phone_call"."party" in ('person', 'other', 'unknown')),
	CONSTRAINT "phone_call_status_check" CHECK ("phone_call"."status" in ('dialing', 'in_progress', 'ended', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "phone_line" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_call" ADD CONSTRAINT "phone_call_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_call_action_idx" ON "phone_call" USING btree ("action_id") WHERE "phone_call"."action_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_call_conversation_idx" ON "phone_call" USING btree ("connection_id","conversation_id") WHERE "phone_call"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "phone_call_count_idx" ON "phone_call" USING btree ("connection_id","direction","created_at");