-- Sandbox connections that can start background processes can also wait for them, now or by a later wake.
UPDATE "connection" SET "scopes" = "scopes" || '["process.wait"]'::jsonb WHERE "provider" = 'sandbox' AND "scopes" ? 'process.start' AND NOT "scopes" ? 'process.wait';
