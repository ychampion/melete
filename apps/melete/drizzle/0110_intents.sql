CREATE TABLE "intent" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"words" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origins" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"waiting_on" jsonb,
	"deadline_at" timestamp with time zone,
	"deadline_day" text,
	"deadline_origin" text,
	"subject_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "intent_state" CHECK ("intent"."state" in ('active', 'waiting', 'at_risk', 'done', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "intent_kind" CHECK ("intent"."kind" in ('meeting', 'booking', 'purchase', 'reply', 'deliver', 'remind_check', 'watch', 'other')),
	CONSTRAINT "intent_source" CHECK ("intent"."source" in ('chat', 'commitment', 'chase')),
	CONSTRAINT "intent_deadline_origin" CHECK ("intent"."deadline_origin" is null or "intent"."deadline_origin" in ('person', 'inferred')),
	CONSTRAINT "intent_title_not_empty" CHECK (length("intent"."title") > 0),
	CONSTRAINT "intent_version" CHECK ("intent"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "intent_effect" (
	"intent_id" text NOT NULL,
	"action_id" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"reversal" jsonb,
	"state" text DEFAULT 'done' NOT NULL,
	"note" text,
	"done_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_effect_intent_id_action_id_pk" PRIMARY KEY("intent_id","action_id"),
	CONSTRAINT "intent_effect_role" CHECK ("intent_effect"."role" in ('primary', 'hold', 'compensation')),
	CONSTRAINT "intent_effect_state" CHECK ("intent_effect"."state" in ('done', 'reversed', 'kept', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "intent" ADD CONSTRAINT "intent_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent" ADD CONSTRAINT "intent_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent" ADD CONSTRAINT "intent_conversation_id_job_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent" ADD CONSTRAINT "intent_run_id_job_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_effect" ADD CONSTRAINT "intent_effect_intent_id_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_effect" ADD CONSTRAINT "intent_effect_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intent_source_idx" ON "intent" USING btree ("space_id","principal_id","source_key");--> statement-breakpoint
CREATE INDEX "intent_principal_idx" ON "intent" USING btree ("principal_id","state","created_at");--> statement-breakpoint
CREATE INDEX "intent_run_idx" ON "intent" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intent_conversation_idx" ON "intent" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "intent_subject_idx" ON "intent" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "intent_effect_action_idx" ON "intent_effect" USING btree ("action_id");