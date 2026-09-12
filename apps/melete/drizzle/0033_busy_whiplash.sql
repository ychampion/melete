ALTER TABLE "connection" ADD COLUMN "configuration" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "setup_state" text DEFAULT 'connected' NOT NULL;