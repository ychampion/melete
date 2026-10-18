CREATE TABLE "oidc_identity" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_identity_issuer_subject_pk" PRIMARY KEY("issuer","subject"),
	CONSTRAINT "oidc_identity_subject" CHECK (length("oidc_identity"."subject") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "oidc_spent_state" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "oidc_link_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oidc_identity" ADD CONSTRAINT "oidc_identity_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_identity_principal_issuer_idx" ON "oidc_identity" USING btree ("principal_id","issuer");--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_external_id_unique" UNIQUE("external_id");