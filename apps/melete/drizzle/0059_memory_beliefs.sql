CREATE TABLE "memory_action_basis" (
	"action_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"domain_key" text NOT NULL,
	"key" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"week_of" text NOT NULL,
	"time_zone" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_rewinds" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"label" text NOT NULL,
	"target" jsonb NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"steps" jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undo_steps" jsonb
);
--> statement-breakpoint
ALTER TABLE "memory_blocks" ADD CONSTRAINT "memory_blocks_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_digests" ADD CONSTRAINT "memory_digests_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_rewinds" ADD CONSTRAINT "memory_rewinds_space_id_memory_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."memory_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_block_subject" ON "memory_blocks" USING btree ("space_id","domain_key") WHERE "memory_blocks"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_digest_week" ON "memory_digests" USING btree ("space_id","week_of");--> statement-breakpoint
CREATE INDEX "memory_rewind_space" ON "memory_rewinds" USING btree ("space_id","created_at");--> statement-breakpoint
-- An action's basis is recorded in the statement that proposes it: what memory
-- handed the attempt that proposed it, or nothing when memory handed it nothing.
CREATE FUNCTION "memory_record_action_basis"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "memory_action_basis" ("action_id", "space_id", "job_id", "attempt_id", "items")
  SELECT NEW."id", j."space_id", NEW."job_id", NEW."attempt_id",
    coalesce((SELECT c."items" FROM "memory_contexts" c WHERE c."attempt_id" = NEW."attempt_id"), '[]'::jsonb)
  FROM "job" j WHERE j."id" = NEW."job_id"
  ON CONFLICT ("action_id") DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_action_basis_on_propose" AFTER INSERT ON "action"
  FOR EACH ROW EXECUTE FUNCTION "memory_record_action_basis"();
