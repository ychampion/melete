CREATE TABLE "episode" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"segment_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"scope" jsonb NOT NULL,
	"template_id" text NOT NULL,
	"input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intervention" jsonb,
	"actor" text NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"judgement" text DEFAULT 'pending' NOT NULL,
	"failure_class" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"generation_state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_attempt" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"versions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_job" (
	"job_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"scope" jsonb NOT NULL,
	"template_id" text NOT NULL,
	"input_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procedure_candidate" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"scope" jsonb NOT NULL,
	"state" text DEFAULT 'candidate' NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"change" jsonb NOT NULL,
	"predicted_benefit" text NOT NULL,
	"known_risk" text NOT NULL,
	"tests" jsonb NOT NULL,
	"compatible_models" jsonb NOT NULL,
	"selected_evaluation_id" text,
	"canary_space_id" text,
	"rejection_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procedure_state_check" CHECK ("procedure_candidate"."state" in ('candidate','evaluated','enabled_canary','active','superseded','reverted'))
);
--> statement-breakpoint
CREATE TABLE "procedure_evaluation" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"phase" text NOT NULL,
	"suite_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procedure_transition" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempt" ADD CONSTRAINT "learning_attempt_attempt_id_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_job" ADD CONSTRAINT "learning_job_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_job" ADD CONSTRAINT "learning_job_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_candidate_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD CONSTRAINT "procedure_candidate_episode_id_episode_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episode"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_evaluation" ADD CONSTRAINT "procedure_evaluation_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_transition" ADD CONSTRAINT "procedure_transition_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_segment_idx" ON "episode" USING btree ("job_id","segment_key");--> statement-breakpoint
CREATE INDEX "episode_space_idx" ON "episode" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "procedure_episode_idx" ON "procedure_candidate" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "procedure_scope_idx" ON "procedure_candidate" USING btree ("space_id","state");