CREATE TABLE "sandbox_process" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"session_id" text,
	"job_id" text,
	"action_id" text,
	"command_redacted" text NOT NULL,
	"command_digest" text NOT NULL,
	"cwd" text NOT NULL,
	"name" text NOT NULL,
	"port" integer,
	"state" text NOT NULL,
	"exit_code" integer,
	"signal" text,
	"boot_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"output_cursor" bigint DEFAULT 0 NOT NULL,
	"output_bytes" bigint DEFAULT 0 NOT NULL,
	"last_line" text,
	"last_output_at" timestamp with time zone,
	"notify" jsonb,
	"trigger_id" text,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_process_state_check" CHECK ("sandbox_process"."state" in ('starting', 'running', 'exited', 'stopped', 'expired', 'lost'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_session_id_sandbox_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sandbox_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_process" ADD CONSTRAINT "sandbox_process_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_process_action_idx" ON "sandbox_process" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "sandbox_process_computer_idx" ON "sandbox_process" USING btree ("space_id","agent_id","state");--> statement-breakpoint
CREATE INDEX "sandbox_process_live_idx" ON "sandbox_process" USING btree ("state","expires_at") WHERE "sandbox_process"."state" in ('starting', 'running');--> statement-breakpoint
UPDATE "connection" SET "scopes" = "scopes" || '["process.start","process.list","process.read","process.write","process.signal","process.stop","process.extend"]'::jsonb WHERE "provider" = 'sandbox' AND "scopes" ? 'terminal.run' AND NOT "scopes" ? 'process.start';
