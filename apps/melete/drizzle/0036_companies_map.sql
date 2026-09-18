CREATE TABLE "company" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"monthly_spend_minor" integer,
	"currency" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_spend_nonnegative" CHECK ("company"."monthly_spend_minor" is null or "company"."monthly_spend_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "company_message" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"message_id" text NOT NULL,
	"subject" text NOT NULL,
	"from_address" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"messages_seen" integer DEFAULT 0 NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_item" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"company_id" text NOT NULL,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" integer,
	"currency" text,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'found' NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggested_playbook" text,
	"job_id" text,
	"summary" text NOT NULL,
	"scan_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_item_amount_nonnegative" CHECK ("ledger_item"."amount_minor" is null or "ledger_item"."amount_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_message" ADD CONSTRAINT "company_message_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_message" ADD CONSTRAINT "company_message_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_scan" ADD CONSTRAINT "company_scan_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_scan" ADD CONSTRAINT "company_scan_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD CONSTRAINT "ledger_item_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD CONSTRAINT "ledger_item_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD CONSTRAINT "ledger_item_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_owner_domain_idx" ON "company" USING btree ("space_id","principal_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "company_message_owner_idx" ON "company_message" USING btree ("space_id","principal_id","message_id");--> statement-breakpoint
CREATE INDEX "company_scan_owner_idx" ON "company_scan" USING btree ("space_id","principal_id","status");--> statement-breakpoint
CREATE INDEX "ledger_item_owner_idx" ON "ledger_item" USING btree ("space_id","principal_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_item_dedupe_idx" ON "ledger_item" USING btree ("space_id","principal_id","dedupe_key");