CREATE TABLE "spend_counter" (
	"period" text NOT NULL,
	"scope" text NOT NULL,
	"usd" double precision DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "spend_counter_period_scope_pk" PRIMARY KEY("period","scope")
);
--> statement-breakpoint
-- Adds one call's dollars and tokens (or takes them away, as negative
-- amounts) to the installation's, its person's and, for a background call,
-- its person's background rows for the call's UTC month and day. The rows are
-- always taken in the same order, so two writers wait for each other rather
-- than deadlock.
CREATE FUNCTION "spend_counter_add"(at_time timestamptz, person text, usage_class text,
    amount double precision, used bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  scopes text[] := ARRAY['installation'];
  periods text[] := ARRAY[to_char(at_time AT TIME ZONE 'UTC', 'YYYY-MM'),
    to_char(at_time AT TIME ZONE 'UTC', 'YYYY-MM-DD')];
  one_scope text;
  one_period text;
BEGIN
  IF amount = 0 AND used = 0 THEN
    RETURN;
  END IF;
  IF person IS NOT NULL THEN
    scopes := scopes || ('person:' || person);
    IF usage_class = 'background' THEN
      scopes := scopes || ('background:' || person);
    END IF;
  END IF;
  FOREACH one_scope IN ARRAY scopes LOOP
    FOREACH one_period IN ARRAY periods LOOP
      INSERT INTO "spend_counter" AS c ("period", "scope", "usd", "tokens")
        VALUES (one_period, one_scope, amount, used)
        ON CONFLICT ("period", "scope") DO UPDATE
          SET "usd" = c."usd" + excluded."usd", "tokens" = c."tokens" + excluded."tokens";
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "model_usage_counts"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "spend_counter_add"(OLD."created_at", OLD."principal_id", OLD."class",
      -OLD."cost_usd", -(OLD."input_tokens"::bigint + OLD."output_tokens"));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "spend_counter_add"(NEW."created_at", NEW."principal_id", NEW."class",
      NEW."cost_usd", NEW."input_tokens"::bigint + NEW."output_tokens");
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "model_usage_counts_cleared"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "spend_counter";
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "model_usage_counts" AFTER INSERT OR DELETE OR UPDATE OF
    "created_at", "principal_id", "class", "cost_usd", "input_tokens", "output_tokens"
  ON "model_usage" FOR EACH ROW EXECUTE FUNCTION "model_usage_counts"();
--> statement-breakpoint
CREATE TRIGGER "model_usage_counts_cleared" AFTER TRUNCATE ON "model_usage"
  FOR EACH STATEMENT EXECUTE FUNCTION "model_usage_counts_cleared"();
--> statement-breakpoint
-- This month's calls so far, today's among them. Creating the trigger above
-- holds off every writer of model_usage until this migration commits, so no
-- call is counted twice or missed.
INSERT INTO "spend_counter" ("period", "scope", "usd", "tokens")
SELECT p."period", s."scope", sum(u."cost_usd"),
  sum(u."input_tokens"::bigint + u."output_tokens")
FROM "model_usage" u
  CROSS JOIN LATERAL (VALUES (to_char(u."created_at" AT TIME ZONE 'UTC', 'YYYY-MM')),
    (to_char(u."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD'))) AS p("period")
  CROSS JOIN LATERAL (VALUES ('installation'), ('person:' || u."principal_id"),
    (CASE WHEN u."class" = 'background' THEN 'background:' || u."principal_id" END)) AS s("scope")
WHERE u."created_at" >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  AND s."scope" IS NOT NULL
GROUP BY p."period", s."scope";
