ALTER TABLE "job" ADD COLUMN "scheduling_class" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "importance" text DEFAULT 'routine' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "unread_results" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "unread_threshold" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "cadence_multiplier" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "attention_status" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "attention_base_wake_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "schedule_skip_remaining" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "last_result_hash" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "last_attention_attempt_id" text;