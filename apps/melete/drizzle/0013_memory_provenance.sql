CREATE TABLE "memory_contradictions" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"key" text NOT NULL,
	"audience" text NOT NULL,
	"claim_id" text NOT NULL,
	"head" text NOT NULL,
	"alternative" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"question_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_contradiction_state" CHECK ("memory_contradictions"."state" in ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "memory_output_uses" (
	"output_row_id" text NOT NULL,
	"handle" text NOT NULL,
	"handle_kind" text NOT NULL,
	"claim_id" text,
	"revision" integer,
	"source_id" text,
	"source_version" text,
	CONSTRAINT "memory_output_uses_output_row_id_handle_pk" PRIMARY KEY("output_row_id","handle"),
	CONSTRAINT "memory_output_handle_kind" CHECK ("memory_output_uses"."handle_kind" in ('claim','source'))
);
--> statement-breakpoint
CREATE TABLE "memory_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text,
	"kind" text NOT NULL,
	"output_id" text NOT NULL,
	"output_version" text NOT NULL,
	"location" text,
	"attributed" boolean DEFAULT false NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_output_kind" CHECK ("memory_outputs"."kind" in ('artifact','plan_step','action'))
);
--> statement-breakpoint
CREATE TABLE "memory_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"key" text NOT NULL,
	"question" text NOT NULL,
	"because" jsonb NOT NULL,
	"if_ignored" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_question_state" CHECK ("memory_questions"."state" in ('queued','answered','withdrawn')),
	CONSTRAINT "memory_question_because" CHECK (jsonb_array_length("memory_questions"."because") > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"work_id" text NOT NULL,
	"proposal_index" integer NOT NULL,
	"key" text,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_repair_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"key" text,
	"changed_handle" text NOT NULL,
	"replacement_handle" text,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"affected" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_repair_state" CHECK ("memory_repair_briefs"."state" in ('pending','delivered'))
);
--> statement-breakpoint
ALTER TABLE "memory_claims" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "memory_contexts" ADD COLUMN "unattributed" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_contexts" ADD COLUMN "disputed_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD COLUMN "origin_trust" text DEFAULT 'inferred' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "author" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "origin_trust" text DEFAULT 'inferred' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "memory_contradictions" ADD CONSTRAINT "memory_contradictions_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_output_uses" ADD CONSTRAINT "memory_output_uses_output_row_id_memory_outputs_id_fk" FOREIGN KEY ("output_row_id") REFERENCES "public"."memory_outputs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_outputs" ADD CONSTRAINT "memory_outputs_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_rejections" ADD CONSTRAINT "memory_rejections_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_repair_briefs" ADD CONSTRAINT "memory_repair_briefs_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_contradiction_open" ON "memory_contradictions" USING btree ("space_id","audience","key") WHERE "memory_contradictions"."state" = 'open';--> statement-breakpoint
CREATE INDEX "memory_output_uses_claim" ON "memory_output_uses" USING btree ("claim_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_output_identity" ON "memory_outputs" USING btree ("space_id","kind","output_id","output_version");--> statement-breakpoint
CREATE INDEX "memory_output_job" ON "memory_outputs" USING btree ("space_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_question_queued" ON "memory_questions" USING btree ("space_id","key") WHERE "memory_questions"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "memory_rejection_space" ON "memory_rejections" USING btree ("space_id","recorded_at");--> statement-breakpoint
CREATE INDEX "memory_repair_pending" ON "memory_repair_briefs" USING btree ("space_id","job_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_claim_key_head" ON "memory_claims" USING btree ("space_id","audience","key") WHERE "memory_claims"."key" is not null and not "memory_claims"."hidden";--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revision_trust" CHECK ("memory_revisions"."origin_trust" in ('owner','verified_connector','external_content','inferred'));--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_author" CHECK ("memory_sources"."author" in ('owner','external'));--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_trust" CHECK ("memory_sources"."origin_trust" in ('owner','verified_connector','external_content','inferred'));