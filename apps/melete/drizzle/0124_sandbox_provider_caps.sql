CREATE TABLE "sandbox_provider_computer" (
	"adapter" text NOT NULL,
	"computer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asleep" boolean DEFAULT false NOT NULL,
	"active_at" timestamp with time zone,
	CONSTRAINT "sandbox_provider_computer_adapter_computer_id_pk" PRIMARY KEY("adapter","computer_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_provider_lease" (
	"id" text PRIMARY KEY NOT NULL,
	"adapter" text NOT NULL,
	"computer_id" text NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sandbox_provider_lease_computer_idx" ON "sandbox_provider_lease" USING btree ("adapter","computer_id");