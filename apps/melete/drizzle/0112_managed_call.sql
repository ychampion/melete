CREATE TABLE "managed_call" (
	"principal_id" text NOT NULL,
	"month" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_call_principal_id_month_pk" PRIMARY KEY("principal_id","month"),
	CONSTRAINT "managed_call_month_check" CHECK ("managed_call"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "managed_call_calls_check" CHECK ("managed_call"."calls" >= 0)
);
--> statement-breakpoint
CREATE INDEX "managed_call_month_idx" ON "managed_call" USING btree ("month");