CREATE TABLE "push_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"because" text NOT NULL,
	"url" text NOT NULL,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" text,
	"sent_at" timestamp with time zone,
	"dropped_at" timestamp with time zone,
	CONSTRAINT "push_intent_dedup_key_unique" UNIQUE("dedup_key"),
	CONSTRAINT "push_intent_because_not_empty" CHECK (length("push_intent"."because") > 0)
);
--> statement-breakpoint
CREATE TABLE "push_setting" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"decisions" boolean DEFAULT true NOT NULL,
	"settled" boolean DEFAULT true NOT NULL,
	"weekly_summary" boolean DEFAULT true NOT NULL,
	"daily_cap" integer DEFAULT 4 NOT NULL,
	"batch_minutes" integer DEFAULT 10 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device_label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "ledger_item" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_intent" ADD CONSTRAINT "push_intent_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_setting" ADD CONSTRAINT "push_setting_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_intent_waiting_idx" ON "push_intent" USING btree ("principal_id") WHERE sent_at is null and dropped_at is null;--> statement-breakpoint
CREATE INDEX "push_subscription_principal_idx" ON "push_subscription" USING btree ("principal_id");