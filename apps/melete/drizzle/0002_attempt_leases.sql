ALTER TABLE "attempt" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "lease_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "runtime_cursor" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "input_cursor" bigint DEFAULT 0 NOT NULL;