ALTER TABLE "experience_turn" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
-- Reminders that came due before this change were already seen or let go; none starts unread.
UPDATE "experience_turn" SET "seen_at" = coalesce("finished_at", "created_at") WHERE starts_with("submission_id", 'wake:');--> statement-breakpoint
ALTER TABLE "push_setting" ADD COLUMN "reminders" boolean DEFAULT true NOT NULL;
