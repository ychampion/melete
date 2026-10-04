CREATE TABLE "usage_day" (
	"day" text NOT NULL,
	"principal_id" text NOT NULL,
	"space_id" text NOT NULL,
	"class" text NOT NULL,
	"tier" text NOT NULL,
	"purpose" text NOT NULL,
	"calls" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cached_input_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"charged_input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_day_day_principal_id_space_id_class_tier_purpose_pk" PRIMARY KEY("day","principal_id","space_id","class","tier","purpose")
);
--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "class" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "class" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "tier" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "situation_id" text;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "charged_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "usage_day_principal_idx" ON "usage_day" USING btree ("principal_id","day");--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_class" CHECK ("attempt"."class" in ('interactive', 'background'));--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_class" CHECK ("model_usage"."class" in ('interactive', 'background'));--> statement-breakpoint
UPDATE "model_usage" SET "class" = 'background', "tier" = 'service' WHERE "purpose" IN ('memory', 'learning');--> statement-breakpoint
UPDATE "model_usage" SET "tier" = 'service' WHERE "purpose" NOT IN ('agent', 'memory', 'learning');--> statement-breakpoint
UPDATE "model_usage" SET "charged_input_tokens" = "input_tokens";