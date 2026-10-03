CREATE TABLE "model_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"space_id" text,
	"principal_id" text,
	"job_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_actual" text,
	"route" text,
	"routed_from" text,
	"status" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage_estimated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spending_notice" (
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_notice_scope_period_level_pk" PRIMARY KEY("scope","period","level")
);
--> statement-breakpoint
CREATE INDEX "model_usage_created_idx" ON "model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usage_principal_idx" ON "model_usage" USING btree ("principal_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_space_idx" ON "model_usage" USING btree ("space_id","created_at");