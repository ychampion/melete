-- Mail connections that can prepare a draft can also discard one, which is how a draft is undone.
UPDATE "connection" SET "scopes" = "scopes" || '["email.discard"]'::jsonb WHERE "provider" = 'imap' AND "scopes" ? 'email.draft' AND NOT "scopes" ? 'email.discard';
