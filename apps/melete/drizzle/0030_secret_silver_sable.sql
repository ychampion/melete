ALTER TABLE "job" ADD COLUMN "experience_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "experience_group" jsonb DEFAULT '[]'::jsonb NOT NULL;