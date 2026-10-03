CREATE TABLE "room_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'guest' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"principal_id" text,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "room_invite_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "room_invite_role" CHECK ("room_invite"."role" in ('guest'))
);
--> statement-breakpoint
ALTER TABLE "space_membership" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_invite" ADD CONSTRAINT "room_invite_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invite" ADD CONSTRAINT "room_invite_created_by_principal_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_invite" ADD CONSTRAINT "room_invite_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_invite_space_idx" ON "room_invite" USING btree ("space_id","created_at");