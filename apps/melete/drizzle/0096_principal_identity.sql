CREATE TABLE "principal_identity" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_identity_provider_external_id_pk" PRIMARY KEY("provider","external_id"),
	CONSTRAINT "principal_identity_provider" CHECK ("principal_identity"."provider" ~ '^[a-z][a-z0-9_-]{0,31}$' and "principal_identity"."provider" <> 'web'),
	CONSTRAINT "principal_identity_external_id" CHECK (length("principal_identity"."external_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "room_message" ADD COLUMN "surface" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_message" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "principal_identity" ADD CONSTRAINT "principal_identity_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "principal_identity_principal_idx" ON "principal_identity" USING btree ("principal_id");--> statement-breakpoint
ALTER TABLE "room_message" ADD CONSTRAINT "room_message_external_ref" CHECK ("room_message"."external_ref" is null or length("room_message"."external_ref") between 1 and 200);