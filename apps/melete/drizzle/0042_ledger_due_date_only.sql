ALTER TABLE "ledger_item" ADD COLUMN "due_date_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Rows admitted before the flag kept a bare date as midnight UTC, and the map read that hour as a date. Keep reading them that way.
UPDATE "ledger_item" SET "due_date_only" = true WHERE "due_at" IS NOT NULL AND "due_at" = date_trunc('day', "due_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
