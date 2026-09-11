ALTER TABLE "action" ADD COLUMN "intent_key" text;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "origin_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_intent_key_idx" ON "action" USING btree ("intent_key");