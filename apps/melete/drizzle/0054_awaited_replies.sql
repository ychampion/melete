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
CREATE INDEX "awaited_reply_owner_idx" ON "awaited_reply" USING btree ("space_id","principal_id","status");--> statement-breakpoint
CREATE INDEX "awaited_reply_job_idx" ON "awaited_reply" USING btree ("job_id") WHERE "awaited_reply"."job_id" is not null;--> statement-breakpoint
-- An awaited reply being chased follows the chase, as a ledger item does. A
-- chase that completes either heard back or gave up and told the person it is
-- still unanswered; either way nothing is waited on here any more, so the row
-- is settled. A chase that fails or is stopped hands the row back, free to be
-- chased again. A row the person settled or dismissed meanwhile is left alone.
-- It is a trigger so every path that finishes a job, the service's and the
-- broker's alike, carries the row with it in the same transaction.
CREATE FUNCTION "awaited_reply_follows_its_chase"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" = 'completed' THEN
    UPDATE "awaited_reply" SET "status" = 'settled'
      WHERE "job_id" = NEW."id" AND "status" IN ('handling', 'waiting');
  ELSE
    UPDATE "awaited_reply" SET "status" = 'found', "job_id" = NULL
      WHERE "job_id" = NEW."id" AND "status" IN ('handling', 'waiting');
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_finishes_awaited_reply" AFTER UPDATE OF "state" ON "job"
  FOR EACH ROW
  WHEN (NEW."state" IN ('completed', 'failed', 'cancelled') AND OLD."state" IS DISTINCT FROM NEW."state")
  EXECUTE FUNCTION "awaited_reply_follows_its_chase"();
