CREATE TABLE "telegram_button" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"choice" text NOT NULL,
	"version" text,
	"message_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_delivery" (
	"link_id" text NOT NULL,
	"message_id" bigint NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_delivery_link_id_message_id_pk" PRIMARY KEY("link_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_link" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_cursor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telegram_link_code" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_poll" (
	"id" text PRIMARY KEY NOT NULL,
	"next_offset" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_button" ADD CONSTRAINT "telegram_button_link_id_telegram_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."telegram_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_delivery" ADD CONSTRAINT "telegram_delivery_link_id_telegram_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."telegram_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link" ADD CONSTRAINT "telegram_link_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_code" ADD CONSTRAINT "telegram_link_code_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_button_message_idx" ON "telegram_button" USING btree ("message_key");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_principal_idx" ON "telegram_link" USING btree ("principal_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_chat_idx" ON "telegram_link" USING btree ("chat_id") WHERE revoked_at is null;