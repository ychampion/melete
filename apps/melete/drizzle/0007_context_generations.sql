ALTER TABLE "attempt" ADD COLUMN "policy_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "connection_generations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "background_operation" ADD COLUMN "policy_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "space" ADD COLUMN "policy_generation" integer DEFAULT 0 NOT NULL;