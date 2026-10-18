CREATE TABLE "composio_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_delivery_id_check" CHECK ("composio_delivery"."id" ~ '^[A-Za-z0-9_.:-]{1,128}$')
);
--> statement-breakpoint
CREATE INDEX "composio_delivery_received_idx" ON "composio_delivery" USING btree ("received_at");