CREATE TABLE "observation_tombstone" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "watch_changes" boolean;--> statement-breakpoint
ALTER TABLE "observation_tombstone" ADD CONSTRAINT "observation_tombstone_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observation_tombstone_seen_idx" ON "observation_tombstone" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "observation_tombstone_connection_idx" ON "observation_tombstone" USING btree ("connection_id");