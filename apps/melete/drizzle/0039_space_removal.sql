ALTER TABLE "space" ADD COLUMN "removed_at" timestamptz;
--> statement-breakpoint
CREATE TABLE "space_removal" (
  "id" text PRIMARY KEY NOT NULL,
  "space_id" text NOT NULL,
  "space_name" text NOT NULL,
  "git_path" text NOT NULL,
  "kind" text NOT NULL,
  "requested_by" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "phase" text NOT NULL DEFAULT 'fence',
  "job_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "connection_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "providers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "blocked_reason" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "space_removal_kind" CHECK ("kind" IN ('removed','emptied')),
  CONSTRAINT "space_removal_state" CHECK ("state" IN ('pending','running','blocked','complete')),
  CONSTRAINT "space_removal_phase" CHECK ("phase" IN ('fence','sessions','journal','sandboxes','browser','runtime','files','operational','principals','memory','verify','space'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "space_removal_live_idx" ON "space_removal" ("space_id") WHERE "state" <> 'complete';
--> statement-breakpoint
CREATE INDEX "space_removal_ready_idx" ON "space_removal" ("state", "lease_expires_at");
--> statement-breakpoint
-- A space under removal takes no new work, connection or mailbox scan, however
-- the insert is written. The service refuses first where it checks authority;
-- this is what holds for every path, including a personal space being emptied.
CREATE FUNCTION "refuse_work_in_removed_space"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "space" WHERE "id" = NEW."space_id" AND "removed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'space_removed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_refuses_removed_space" BEFORE INSERT ON "job"
  FOR EACH ROW EXECUTE FUNCTION "refuse_work_in_removed_space"();
--> statement-breakpoint
CREATE TRIGGER "connection_refuses_removed_space" BEFORE INSERT ON "connection"
  FOR EACH ROW EXECUTE FUNCTION "refuse_work_in_removed_space"();
--> statement-breakpoint
CREATE TRIGGER "company_scan_refuses_removed_space" BEFORE INSERT ON "company_scan"
  FOR EACH ROW EXECUTE FUNCTION "refuse_work_in_removed_space"();
