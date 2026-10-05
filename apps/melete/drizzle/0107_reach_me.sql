CREATE TABLE "reach_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"number" text NOT NULL,
	"texts" boolean NOT NULL,
	"calls" boolean NOT NULL,
	"nights" boolean NOT NULL,
	"wording" text NOT NULL,
	"agreed_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_how" text,
	CONSTRAINT "reach_consent_withdrawn" CHECK (("reach_consent"."withdrawn_at" is null) = ("reach_consent"."withdrawn_how" is null))
);
--> statement-breakpoint
CREATE TABLE "reach_contact" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"situation_id" text,
	"purpose" text NOT NULL,
	"channel" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"number" text,
	"provider_ref" text,
	"provider_status" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reach_contact_channel" CHECK ("reach_contact"."channel" in ('push', 'text', 'call')),
	CONSTRAINT "reach_contact_purpose" CHECK ("reach_contact"."purpose" in ('ladder', 'code', 'notice')),
	CONSTRAINT "reach_contact_state" CHECK ("reach_contact"."state" in ('waiting', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled', 'unknown')),
	CONSTRAINT "reach_contact_ladder_situation" CHECK ("reach_contact"."purpose" <> 'ladder' or "reach_contact"."situation_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "reach_number" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"number" text,
	"verified_at" timestamp with time zone,
	"pending_number" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_tries" integer DEFAULT 0 NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reach_number_verified" CHECK (("reach_number"."number" is null) = ("reach_number"."verified_at" is null))
);
--> statement-breakpoint
CREATE TABLE "reach_reply" (
	"message_sid" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reach_consent" ADD CONSTRAINT "reach_consent_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reach_contact" ADD CONSTRAINT "reach_contact_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reach_contact" ADD CONSTRAINT "reach_contact_situation_id_situation_id_fk" FOREIGN KEY ("situation_id") REFERENCES "public"."situation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reach_number" ADD CONSTRAINT "reach_number_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reach_consent_live_idx" ON "reach_consent" USING btree ("principal_id") WHERE "reach_consent"."withdrawn_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reach_contact_rung_idx" ON "reach_contact" USING btree ("situation_id","channel") WHERE "reach_contact"."situation_id" is not null;--> statement-breakpoint
CREATE INDEX "reach_contact_principal_idx" ON "reach_contact" USING btree ("principal_id","created_at");--> statement-breakpoint
CREATE INDEX "reach_contact_due_idx" ON "reach_contact" USING btree ("due_at") WHERE "reach_contact"."state" = 'waiting';--> statement-breakpoint
CREATE INDEX "reach_contact_ref_idx" ON "reach_contact" USING btree ("provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "reach_number_number_idx" ON "reach_number" USING btree ("number") WHERE "reach_number"."number" is not null;