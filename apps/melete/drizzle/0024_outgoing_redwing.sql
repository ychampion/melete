CREATE TABLE "learning_model_call" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"settlement" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_model_call_episode_id_unique" UNIQUE("episode_id")
);
--> statement-breakpoint
ALTER TABLE "episode" ADD COLUMN "generation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_model_call" ADD CONSTRAINT "learning_model_call_episode_id_episode_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episode"("id") ON DELETE cascade ON UPDATE no action;