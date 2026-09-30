CREATE TABLE "password_reset" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"via" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experience_profile" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experience_profile" ADD COLUMN "time_zone_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "password_reset" ADD CONSTRAINT "password_reset_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_reset_principal_created_idx" ON "password_reset" USING btree ("principal_id","created_at");