ALTER TABLE "ledger_item" ADD COLUMN "last_job_id" text;--> statement-breakpoint
CREATE INDEX "ledger_item_job_idx" ON "ledger_item" USING btree ("job_id") WHERE "ledger_item"."job_id" is not null;--> statement-breakpoint
-- A ledger item being handled follows the chase handling it. A chase that
-- completes has done what it could, and only the person can say the company
-- actually paid, so the item waits for them, still counted, with the chase on
-- it; they settle it themselves. A chase that fails or is stopped hands the
-- item back open, free to be handled again, and remembers which chase it was.
-- It is a trigger so every path that finishes a job, the service's and the
-- broker's alike, carries the ledger with it in the same transaction.
CREATE FUNCTION "ledger_follows_its_chase"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
--> statement-breakpoint
CREATE TRIGGER "job_finishes_ledger_item" AFTER UPDATE OF "state" ON "job"
  FOR EACH ROW
  WHEN (NEW."state" IN ('completed', 'failed', 'cancelled') AND OLD."state" IS DISTINCT FROM NEW."state")
  EXECUTE FUNCTION "ledger_follows_its_chase"();
