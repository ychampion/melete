CREATE TABLE "action" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"effect_class" text NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"authorization_ref" text,
	"budget_reservation" text,
	"idempotency_key" text NOT NULL,
	"dispatched_at" timestamp with time zone,
	"receipt" jsonb,
	"resolved_at" timestamp with time zone,
	"reconciliation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"job_revision" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decided_by" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"audience" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"runtime_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_actual" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"outcome_detail" jsonb,
	"context_snapshot_ref" text
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text,
	"action_id" text,
	"kind" text NOT NULL,
	"reserved" double precision NOT NULL,
	"settled" double precision,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"secret_ref" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"next_wake_at" timestamp with time zone,
	"wait" jsonb DEFAULT '{"kind":"none"}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_record" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"path" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"passkey" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"audience" text DEFAULT 'owner' NOT NULL,
	"git_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"cursor" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action" ADD CONSTRAINT "action_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action" ADD CONSTRAINT "action_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action" ADD CONSTRAINT "action_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ledger" ADD CONSTRAINT "budget_ledger_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ledger" ADD CONSTRAINT "budget_ledger_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ledger" ADD CONSTRAINT "budget_ledger_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_secret_ref_secret_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_record" ADD CONSTRAINT "knowledge_record_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger" ADD CONSTRAINT "trigger_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_job_status_idx" ON "action" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "action_idempotency_idx" ON "action" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_action_hash_idx" ON "approval" USING btree ("action_id","payload_hash");--> statement-breakpoint
CREATE INDEX "artifact_space_idx" ON "artifact" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_job_epoch_idx" ON "attempt" USING btree ("job_id","epoch");--> statement-breakpoint
CREATE INDEX "budget_job_idx" ON "budget_ledger" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "connection_space_idx" ON "connection" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_dedup_idx" ON "event" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "event_job_seq_idx" ON "event" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "job_space_state_idx" ON "job" USING btree ("space_id","state");--> statement-breakpoint
CREATE INDEX "job_next_wake_idx" ON "job" USING btree ("next_wake_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_space_path_idx" ON "knowledge_record" USING btree ("space_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_space_name_idx" ON "skill" USING btree ("space_id","name");--> statement-breakpoint
CREATE INDEX "trigger_job_idx" ON "trigger" USING btree ("job_id");