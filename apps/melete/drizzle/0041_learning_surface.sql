CREATE TABLE "learned_change" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"source" text NOT NULL,
	"item_id" text NOT NULL,
	"candidate_id" text,
	"action" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "learning_notice" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"definition_hash" text NOT NULL,
	"reason_code" text,
	"state" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"episode_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "learning_notice_kind_check" CHECK ("learning_notice"."kind" in ('keep_question', 'reverted')),
	CONSTRAINT "learning_notice_state_check" CHECK ("learning_notice"."state" in ('open', 'answered', 'withdrawn', 'read')),
	CONSTRAINT "learning_notice_answer_check" CHECK ("learning_notice"."answer" is null or "learning_notice"."answer" in ('yes', 'no', 'change'))
);
--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "procedure_candidate" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learned_change" ADD CONSTRAINT "learned_change_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_change" ADD CONSTRAINT "learned_change_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_notice" ADD CONSTRAINT "learning_notice_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_notice" ADD CONSTRAINT "learning_notice_candidate_id_procedure_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."procedure_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_notice" ADD CONSTRAINT "learning_notice_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learned_change_principal_idx" ON "learned_change" USING btree ("space_id","principal_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_notice_principal_idx" ON "learning_notice" USING btree ("space_id","principal_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_notice_open_question_idx" ON "learning_notice" USING btree ("candidate_id") WHERE "learning_notice"."kind" = 'keep_question' and "learning_notice"."state" = 'open';