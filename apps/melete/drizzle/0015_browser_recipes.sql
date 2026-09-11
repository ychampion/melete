CREATE TABLE "browser_recipe_candidate" (
  "id" text NOT NULL,
  "space_id" text NOT NULL REFERENCES "space"("id") ON DELETE CASCADE,
  "version" integer NOT NULL CHECK ("version" > 0),
  "state" text NOT NULL CHECK ("state" IN ('candidate', 'validated', 'promoted', 'rejected', 'superseded')),
  "schema" jsonb NOT NULL CHECK (jsonb_typeof("schema") = 'array'),
  "steps" jsonb NOT NULL CHECK (jsonb_typeof("steps") = 'array'),
  "safe_aliases" jsonb NOT NULL CHECK (jsonb_typeof("safe_aliases") = 'object'),
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("space_id", "id", "version")
);
--> statement-breakpoint
CREATE INDEX "browser_recipe_candidate_space_state_idx"
  ON "browser_recipe_candidate" ("space_id", "state");
