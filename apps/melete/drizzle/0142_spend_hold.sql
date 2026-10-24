CREATE TABLE "spend_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text,
	"class" text NOT NULL,
	"usd" double precision NOT NULL,
	"tokens" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spend_hold_expires_idx" ON "spend_hold" USING btree ("expires_at");