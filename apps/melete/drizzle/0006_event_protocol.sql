CREATE TABLE "event_retention" (
	"id" text PRIMARY KEY NOT NULL,
	"retained_after" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "epoch" integer;