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
