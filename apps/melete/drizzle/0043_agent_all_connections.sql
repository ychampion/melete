ALTER TABLE "agent" ALTER COLUMN "allowed_connection_ids" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "allowed_connection_ids" DROP NOT NULL;--> statement-breakpoint
-- Until now an empty list was also every new agent's default, so it reads as "all of this space's connections".
UPDATE "agent" SET "allowed_connection_ids" = NULL WHERE "allowed_connection_ids" = '[]'::jsonb;
