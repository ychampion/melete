CREATE TABLE "blob_ref" (
	"key" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"space_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_ref_key_owner_kind_owner_id_pk" PRIMARY KEY("key","owner_kind","owner_id"),
	CONSTRAINT "blob_ref_key_shape" CHECK ("blob_ref"."key" ~ '^sha256/[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "blob_ref" ADD CONSTRAINT "blob_ref_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_ref_space_idx" ON "blob_ref" USING btree ("space_id");