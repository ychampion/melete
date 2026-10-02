CREATE TABLE "orphaned_routine_thread" (
	"job_id" text PRIMARY KEY NOT NULL
);--> statement-breakpoint
-- Threads that deleted routines left behind: a routine job cancelled because
-- its routine was deleted, which no schedule names any more. Listed once here;
-- the service removes each at start and takes it off the list.
INSERT INTO "orphaned_routine_thread" ("job_id")
SELECT j."id" FROM "job" j
WHERE j."kind" = 'routine' AND j."state" = 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM "trigger" t WHERE t."job_id" = j."id")
  AND EXISTS (SELECT 1 FROM "event" e WHERE e."job_id" = j."id"
    AND e."type" = 'job_state_changed' AND e."payload"->>'reason' = 'routine_deleted');
