CREATE TABLE "device_pairing" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "paired_device" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"token_hash" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"local_capabilities" jsonb NOT NULL,
	"folders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"companion_version" text,
	"paired_by" text NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_pairing" ADD CONSTRAINT "device_pairing_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paired_device" ADD CONSTRAINT "paired_device_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paired_device" ADD CONSTRAINT "paired_device_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairing_code_idx" ON "device_pairing" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "device_pairing_space_idx" ON "device_pairing" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paired_device_token_idx" ON "paired_device" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "paired_device_connection_idx" ON "paired_device" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "paired_device_space_idx" ON "paired_device" USING btree ("space_id");