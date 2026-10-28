CREATE TABLE "privacy_seen" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"source" text NOT NULL,
	"tool" text,
	"digest" text NOT NULL,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_seen" ADD CONSTRAINT "privacy_seen_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_seen_piece_idx" ON "privacy_seen" USING btree ("conversation_id","digest");--> statement-breakpoint
CREATE INDEX "privacy_seen_turn_idx" ON "privacy_seen" USING btree ("conversation_id","turn_id");