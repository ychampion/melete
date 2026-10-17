CREATE TABLE "person_spend_limit" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"day_usd" double precision,
	"month_usd" double precision,
	"background_day_usd" double precision,
	"background_month_usd" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_spend_limit_positive" CHECK (coalesce("person_spend_limit"."day_usd", 1) > 0 and coalesce("person_spend_limit"."month_usd", 1) > 0
        and coalesce("person_spend_limit"."background_day_usd", 1) > 0 and coalesce("person_spend_limit"."background_month_usd", 1) > 0)
);
--> statement-breakpoint
ALTER TABLE "person_spend_limit" ADD CONSTRAINT "person_spend_limit_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;