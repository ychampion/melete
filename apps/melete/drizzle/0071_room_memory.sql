CREATE TABLE "memory_room_capture" (
	"message_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"outcome" text NOT NULL,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_room_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"source_space_id" text NOT NULL,
	"room_space_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"members_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_sources" DROP CONSTRAINT "memory_source_author";--> statement-breakpoint
ALTER TABLE "memory_sources" ADD COLUMN "author_principal_id" text;--> statement-breakpoint
CREATE INDEX "memory_room_capture_source" ON "memory_room_capture" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_room_grant_active" ON "memory_room_grant" USING btree ("claim_id","room_space_id") WHERE "memory_room_grant"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "memory_room_grant_room" ON "memory_room_grant" USING btree ("room_space_id");--> statement-breakpoint
CREATE INDEX "memory_room_grant_source" ON "memory_room_grant" USING btree ("source_space_id","claim_id");--> statement-breakpoint
ALTER TABLE "memory_sources" ADD CONSTRAINT "memory_source_author" CHECK ("memory_sources"."author" in ('owner','external','member'));