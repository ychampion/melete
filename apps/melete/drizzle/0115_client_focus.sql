CREATE TABLE "client_focus" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"focused_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_focus" ADD CONSTRAINT "client_focus_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;