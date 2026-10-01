ALTER TABLE "learning_model_call" DROP CONSTRAINT "learning_model_call_episode_id_unique";--> statement-breakpoint
ALTER TABLE "learning_model_call" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_model_call" ADD CONSTRAINT "learning_model_call_episode_attempt" UNIQUE("episode_id","attempt");