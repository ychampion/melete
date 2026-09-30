CREATE TABLE "model_default" (
	"id" text PRIMARY KEY DEFAULT 'installation' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"owner_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_default_single_row" CHECK ("model_default"."id" = 'installation')
);
--> statement-breakpoint
CREATE TABLE "model_provider_key" (
	"provider" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"secret_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last_four" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_default" ADD CONSTRAINT "model_default_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_key" ADD CONSTRAINT "model_provider_key_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;