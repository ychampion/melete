CREATE TABLE "action_review" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"job_id" text NOT NULL,
	"space_id" text NOT NULL,
	"tier" text NOT NULL,
	"action_class" text,
	"decided_by" text NOT NULL,
	"outcome" text NOT NULL,
	"risk" text,
	"reason" text NOT NULL,
	"model" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_review_outcome" CHECK ("action_review"."outcome" in ('approved', 'escalated')),
	CONSTRAINT "action_review_decided_by" CHECK ("action_review"."decided_by" in ('policy', 'reviewer'))
);
--> statement-breakpoint
CREATE TABLE "approval_review_policy" (
	"space_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'auto_review' NOT NULL,
	"classes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_review_policy_mode" CHECK ("approval_review_policy"."mode" in ('ask', 'auto_review'))
);
--> statement-breakpoint
ALTER TABLE "action_review" ADD CONSTRAINT "action_review_action_id_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_review" ADD CONSTRAINT "action_review_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_review" ADD CONSTRAINT "action_review_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_review_policy" ADD CONSTRAINT "approval_review_policy_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_review_action_idx" ON "action_review" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "action_review_space_idx" ON "action_review" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "action_review_job_idx" ON "action_review" USING btree ("job_id","created_at");