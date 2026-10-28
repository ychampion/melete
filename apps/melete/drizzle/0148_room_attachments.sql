ALTER TABLE "attachment" ADD COLUMN "room_message_id" text;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_room_message_id_room_message_id_fk" FOREIGN KEY ("room_message_id") REFERENCES "public"."room_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_room_message_idx" ON "attachment" USING btree ("room_message_id");