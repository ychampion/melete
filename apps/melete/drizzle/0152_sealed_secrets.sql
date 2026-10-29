CREATE TABLE "space_secret" (
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"host" text,
	"secret_ref" text NOT NULL,
	"principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_secret_space_id_name_pk" PRIMARY KEY("space_id","name"),
	CONSTRAINT "space_secret_name" CHECK ("space_secret"."name" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "secret" jsonb;--> statement-breakpoint
ALTER TABLE "space_secret" ADD CONSTRAINT "space_secret_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;