CREATE TABLE "sandbox_control" (
	"provider_sandbox_id" text PRIMARY KEY NOT NULL,
	"control" text NOT NULL,
	"epoch" integer NOT NULL,
	"principal_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	CONSTRAINT "sandbox_control_control_check" CHECK ("sandbox_control"."control" in ('agent', 'human'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_control" ADD CONSTRAINT "sandbox_control_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;