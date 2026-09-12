CREATE TABLE "magic_link" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connection_generation" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "experience_category" text;--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "magic_link_owner_created_idx" ON "magic_link" USING btree ("owner_id","created_at");