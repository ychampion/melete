CREATE TABLE "browser_site_profile" (
	"space_id" text NOT NULL,
	"domain" text NOT NULL,
	"label" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_site_profile_space_id_domain_pk" PRIMARY KEY("space_id","domain"),
	CONSTRAINT "browser_site_domain_lower" CHECK ("browser_site_profile"."domain" = lower("browser_site_profile"."domain"))
);
--> statement-breakpoint
ALTER TABLE "browser_site_profile" ADD CONSTRAINT "browser_site_profile_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;