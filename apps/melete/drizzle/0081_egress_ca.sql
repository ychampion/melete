CREATE TABLE "egress_ca" (
	"id" text PRIMARY KEY NOT NULL,
	"cert_pem" text NOT NULL,
	"sealed_key" text NOT NULL,
	"name_constraints" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "egress_record" ADD COLUMN "write_action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "egress_ca_current_idx" ON "egress_ca" USING btree ("superseded_at","created_at");