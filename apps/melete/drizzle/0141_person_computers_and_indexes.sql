ALTER TABLE "sandbox_session" ADD COLUMN "person_id" text;--> statement-breakpoint
CREATE INDEX "event_backup_note_idx" ON "event" USING btree ("seq") WHERE "event"."job_id" is null and "event"."type" = 'notice' and "event"."payload"->>'kind' = 'backup_taken';--> statement-breakpoint
CREATE INDEX "saved_sign_in_use_space_idx" ON "saved_sign_in_use" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "session_person_idx" ON "session" USING btree ((coalesce("principal_id", "owner_id")),"created_at");