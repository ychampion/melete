CREATE TABLE "browser_session_binding" (
  "id" text PRIMARY KEY NOT NULL,
  "space_id" text NOT NULL REFERENCES "space"("id") ON DELETE CASCADE,
  "job_id" text NOT NULL REFERENCES "job"("id") ON DELETE CASCADE,
  "control_epoch" integer NOT NULL CHECK ("control_epoch" >= 0),
  "control" text NOT NULL CHECK ("control" IN ('automation', 'human')),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "browser_session_binding_job_idx" ON "browser_session_binding" ("job_id");
