ALTER TABLE "agent" ADD COLUMN "uses_computer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reads_memory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "writes_memory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_default_space_idx" ON "agent" USING btree ("space_id") WHERE is_default;--> statement-breakpoint
INSERT INTO "agent" ("id", "space_id", "name", "role", "colour", "surface", "eye_colour", "tone", "standing_instruction", "allowed_connection_ids", "asks_before_acting", "is_default")
SELECT 'agent_' || upper(md5(s.id || ':melete')), s.id, 'Melete', 'Your assistant', '#2F5FD6', 'rounded', '#14275C', 'Warm and clear', '', CASE WHEN s.kind = 'shared' THEN '[]'::jsonb END, true, true
FROM "space" s
WHERE NOT EXISTS (SELECT 1 FROM "agent" a WHERE a.space_id = s.id AND a.is_default);--> statement-breakpoint
UPDATE "job" j SET "agent_id" = a.id
FROM "agent" a, "space" s
WHERE a.space_id = j.space_id AND a.is_default AND s.id = j.space_id AND s.kind <> 'shared'
  AND j.agent_id IS NULL AND j.kind IN ('chat', 'routine');
