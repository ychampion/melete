CREATE TABLE "voice_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_usage_kind" CHECK ("voice_usage"."kind" in ('transcribe', 'speech', 'session')),
	CONSTRAINT "voice_usage_amount" CHECK ("voice_usage"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "voice_usage_principal" ON "voice_usage" USING btree ("principal_id","kind","created_at");