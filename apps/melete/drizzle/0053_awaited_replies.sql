CREATE TABLE "awaited_reply" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"message_id" text NOT NULL,
	"to_address" text NOT NULL,
	"to_name" text,
	"subject" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'found' NOT NULL,
	"job_id" text,
	"scan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "awaited_reply_status" CHECK ("awaited_reply"."status" in ('found', 'handling', 'waiting', 'settled', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "awaited_reply" ADD CONSTRAINT "awaited_reply_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awaited_reply" ADD CONSTRAINT "awaited_reply_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "awaited_reply_owner_message_idx" ON "awaited_reply" USING btree ("space_id","principal_id","message_id");--> statement-breakpoint
CREATE INDEX "awaited_reply_owner_idx" ON "awaited_reply" USING btree ("space_id","principal_id","status");