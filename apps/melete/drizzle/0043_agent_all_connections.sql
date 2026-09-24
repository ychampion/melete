ALTER TABLE "agent" ALTER COLUMN "allowed_connection_ids" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "allowed_connection_ids" DROP NOT NULL;--> statement-breakpoint
-- Until now an empty list was every new agent's default, so a personal space's agents read it as "all of this space's connections".
-- A shared space's agents keep none, so members' chats reach a connection only once the owner ticks it.
UPDATE "agent" SET "allowed_connection_ids" = NULL WHERE "allowed_connection_ids" = '[]'::jsonb AND "space_id" IN (SELECT "id" FROM "space" WHERE "kind" = 'personal');
