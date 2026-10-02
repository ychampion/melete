-- Sandbox connections that can start background processes can also wait for them, now or by a later wake.
UPDATE "connection" SET "scopes" = "scopes" || '["process.wait"]'::jsonb WHERE "provider" = 'sandbox' AND "scopes" ? 'process.start' AND NOT "scopes" ? 'process.wait';--> statement-breakpoint
-- The process monitor looks up watches on background processes by the process they follow.
CREATE INDEX IF NOT EXISTS "trigger_process_watch_idx" ON "trigger" ((spec #>> '{predicate,all,0,value}')) WHERE kind = 'watch' AND spec->>'event_name' in ('process.exited', 'process.output', 'process.listening');
