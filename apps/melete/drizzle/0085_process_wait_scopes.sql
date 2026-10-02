-- Sandbox connections that can start background processes can also wait for them and be woken by them.
UPDATE "connection" SET "scopes" = "scopes" || '["process.wait","process.watch"]'::jsonb WHERE "provider" = 'sandbox' AND "scopes" ? 'process.start' AND NOT "scopes" ? 'process.wait';
