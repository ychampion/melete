ALTER TABLE "memory_work" ADD COLUMN "provider_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_work" ADD COLUMN "retry_at" timestamp with time zone;
