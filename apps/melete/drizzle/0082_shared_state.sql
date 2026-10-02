CREATE TABLE "ops_instance" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_window" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"state" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signin_pending" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"sealed_payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_window_expires_idx" ON "rate_limit_window" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signin_pending_subject_idx" ON "signin_pending" USING btree ("kind","subject");--> statement-breakpoint
CREATE INDEX "signin_pending_expires_idx" ON "signin_pending" USING btree ("expires_at");