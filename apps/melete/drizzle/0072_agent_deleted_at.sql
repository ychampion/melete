-- Set when the person deletes an agent. The row stays so the turns it
-- answered keep naming it; a deleted agent is no longer listed or mentioned.
ALTER TABLE "agent" ADD COLUMN "deleted_at" timestamp with time zone;