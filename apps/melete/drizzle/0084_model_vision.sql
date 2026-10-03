CREATE TABLE "model_vision" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"supports_vision" boolean NOT NULL,
	"owner_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_vision_provider_model_pk" PRIMARY KEY("provider","model")
);
--> statement-breakpoint
ALTER TABLE "model_vision" ADD CONSTRAINT "model_vision_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;