CREATE TABLE "call_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_usage_seconds" CHECK ("call_usage"."seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX "call_usage_principal" ON "call_usage" USING btree ("principal_id","started_at");