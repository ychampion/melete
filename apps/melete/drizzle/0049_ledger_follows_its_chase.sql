CREATE INDEX "ledger_item_job_idx" ON "ledger_item" USING btree ("job_id") WHERE "ledger_item"."job_id" is not null;--> statement-breakpoint
-- A ledger item being handled follows the chase handling it. A chase can only
-- complete with evidence the company resolved it, so completing settles the
-- item and the totals stop counting it. A chase that fails or is stopped hands
-- the item back, open and free to be handled again. It is a trigger so every
-- path that finishes a job, the service's and the broker's alike, carries the
-- ledger with it in the same transaction.
CREATE FUNCTION "ledger_follows_its_chase"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ledger_item"
    SET "status" = CASE WHEN NEW."state" = 'completed' THEN 'settled' ELSE 'found' END,
        "job_id" = CASE WHEN NEW."state" = 'completed' THEN "job_id" ELSE NULL END
    WHERE "job_id" = NEW."id" AND "status" IN ('handling', 'waiting');
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_finishes_ledger_item" AFTER UPDATE OF "state" ON "job"
  FOR EACH ROW
  WHEN (NEW."state" IN ('completed', 'failed', 'cancelled') AND OLD."state" IS DISTINCT FROM NEW."state")
  EXECUTE FUNCTION "ledger_follows_its_chase"();
