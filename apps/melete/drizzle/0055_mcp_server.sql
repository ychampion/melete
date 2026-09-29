CREATE TABLE "mcp_authorization" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"space_id" text NOT NULL,
	"membership_generation" integer,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_client" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"family" text NOT NULL,
	"client_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"space_id" text NOT NULL,
	"membership_generation" integer,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_authorization" ADD CONSTRAINT "mcp_authorization_client_id_mcp_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_authorization" ADD CONSTRAINT "mcp_authorization_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_authorization" ADD CONSTRAINT "mcp_authorization_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_client_id_mcp_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_authorization_expires_idx" ON "mcp_authorization" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_token_family_idx" ON "mcp_token" USING btree ("family");--> statement-breakpoint
CREATE INDEX "mcp_token_principal_idx" ON "mcp_token" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "mcp_token_expires_idx" ON "mcp_token" USING btree ("expires_at");