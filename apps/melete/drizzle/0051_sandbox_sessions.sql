CREATE TABLE "sandbox_command" (
	"action_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"marker" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"exit_code" integer,
	"reattached" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_session" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"agent_id" text,
	"adapter" text NOT NULL,
	"provider_sandbox_id" text NOT NULL,
	"image_ref" text NOT NULL,
	"image_digest" text,
	"region" text,
	"egress_policy" jsonb NOT NULL,
	"persistence" text NOT NULL,
	"resume_ref" text,
	"status" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"seconds_charged" double precision,
	"budget_ledger_id" text,
	"last_error" text,
	CONSTRAINT "sandbox_session_status_check" CHECK ("sandbox_session"."status" in ('opening', 'ready', 'paused', 'closing', 'closed', 'lost')),
	CONSTRAINT "sandbox_session_persistence_check" CHECK ("sandbox_session"."persistence" in ('ephemeral', 'pause', 'snapshot'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_command" ADD CONSTRAINT "sandbox_command_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_command" ADD CONSTRAINT "sandbox_command_session_id_sandbox_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sandbox_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_session_provider_idx" ON "sandbox_session" USING btree ("adapter","provider_sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_session_attempt_idx" ON "sandbox_session" USING btree ("attempt_id") WHERE "sandbox_session"."attempt_id" is not null and "sandbox_session"."status" <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_workspace_idx" ON "sandbox_session" USING btree ("space_id","agent_id") WHERE "sandbox_session"."agent_id" is not null and "sandbox_session"."status" in ('ready', 'paused');--> statement-breakpoint
CREATE INDEX "sandbox_session_lease_idx" ON "sandbox_session" USING btree ("lease_expires_at") WHERE "sandbox_session"."status" <> 'closed';