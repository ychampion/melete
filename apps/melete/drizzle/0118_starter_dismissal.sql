CREATE TABLE "starter_dismissal" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "starter_dismissal" ADD CONSTRAINT "starter_dismissal_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;