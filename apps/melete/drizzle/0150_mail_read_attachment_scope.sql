-- Mail connections that can read a message can also read its attachments.
UPDATE "connection" SET "scopes" = "scopes" || '["email.read_attachment"]'::jsonb WHERE "provider" = 'imap' AND "scopes" ? 'email.read' AND NOT "scopes" ? 'email.read_attachment';
