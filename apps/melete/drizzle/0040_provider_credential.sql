CREATE TABLE "provider_credential" (
	"provider" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"secret_id" text,
	"ciphertext" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"account" text,
	"expires_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;