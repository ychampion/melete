ALTER TABLE "activity_record" ADD COLUMN "reversal" jsonb;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "undo_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_record" ADD COLUMN "undone_by" text;