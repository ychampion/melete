-- A ledger item a connection published names that connection and keeps what it said
-- about the item beyond the ledger's own columns. The companies a feed adds and the
-- source texts its items quote name the connection too. Removing the connection's
-- row removes all three; revoking it or switching it off hides them, which the
-- service checks on read.
ALTER TABLE "company" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "company_message" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_message" ADD CONSTRAINT "company_message_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD CONSTRAINT "ledger_item_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_connection_idx" ON "company" USING btree ("connection_id") WHERE "company"."connection_id" is not null;--> statement-breakpoint
CREATE INDEX "company_message_connection_idx" ON "company_message" USING btree ("connection_id") WHERE "company_message"."connection_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_item_connection_idx" ON "ledger_item" USING btree ("connection_id") WHERE "ledger_item"."connection_id" is not null;--> statement-breakpoint
-- A step a person takes on an item a connection published ends with the item open
-- again, whatever came of it: the connection, not the step, says when the matter
-- is over, and the item is free to take its next step. The step stays on record
-- as the item's last job, also on an item that was settled or dropped meanwhile.
-- Every other item follows its chase as before.
CREATE OR REPLACE FUNCTION "ledger_follows_its_chase"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ledger_item" SET "last_job_id" = "job_id", "job_id" = NULL,
    "status" = CASE WHEN "status" IN ('handling', 'waiting') THEN 'found' ELSE "status" END
    WHERE "job_id" = NEW."id" AND "connection_id" IS NOT NULL;
  IF NEW."state" = 'completed' THEN
    UPDATE "ledger_item" SET "status" = 'waiting'
      WHERE "job_id" = NEW."id" AND "status" = 'handling';
  ELSE
    UPDATE "ledger_item" SET "status" = 'found', "last_job_id" = "job_id", "job_id" = NULL
      WHERE "job_id" = NEW."id" AND "status" IN ('handling', 'waiting');
  END IF;
  RETURN NEW;
END
$$;
