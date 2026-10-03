CREATE TABLE "sandbox_control" (
	"provider_sandbox_id" text PRIMARY KEY NOT NULL,
	"control" text NOT NULL,
	"epoch" integer NOT NULL,
	"principal_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_control_control_check" CHECK ("sandbox_control"."control" in ('agent', 'human'))
);
--> statement-breakpoint
ALTER TABLE "sandbox_control" ADD CONSTRAINT "sandbox_control_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_control_human_idx" ON "sandbox_control" USING btree ("provider_sandbox_id") WHERE "sandbox_control"."control" = 'human';