CREATE TABLE "sms_text" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"space_id" text NOT NULL,
	"direction" text NOT NULL,
	"counterpart" text NOT NULL,
	"body" text NOT NULL,
	"from_you" boolean DEFAULT false NOT NULL,
	"message_sid" text,
	"job_id" text,
	"turn_id" text,
	"part" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_text_direction" CHECK ("sms_text"."direction" in ('in', 'out')),
	CONSTRAINT "sms_text_state" CHECK ("sms_text"."state" in ('conversation', 'kept', 'refused', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "sms_text" ADD CONSTRAINT "sms_text_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_text" ADD CONSTRAINT "sms_text_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_text" ADD CONSTRAINT "sms_text_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_text_message_idx" ON "sms_text" USING btree ("connection_id","message_sid") WHERE "sms_text"."direction" = 'in' and "sms_text"."message_sid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_text_reply_idx" ON "sms_text" USING btree ("turn_id","part") WHERE "sms_text"."direction" = 'out' and "sms_text"."turn_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_text_connection_idx" ON "sms_text" USING btree ("connection_id","created_at");