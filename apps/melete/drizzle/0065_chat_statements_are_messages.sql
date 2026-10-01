-- "Remember that ..." typed in chat was stored as an owner edit, so it read as a correction. It is the person's own message; the trust class it carries is unchanged.
UPDATE "memory_sources" SET "source_type" = 'message' WHERE "publisher" = 'chat' AND "stream" = 'chat' AND "source_type" = 'owner_edit' AND "author" = 'owner';
