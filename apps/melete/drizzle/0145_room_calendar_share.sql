CREATE TABLE "room_calendar_share" (
	"space_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"mode" text NOT NULL,
	"membership_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "room_calendar_share_space_id_principal_id_pk" PRIMARY KEY("space_id","principal_id"),
	CONSTRAINT "room_calendar_share_mode" CHECK ("room_calendar_share"."mode" in ('freebusy', 'freebusy_add')),
	CONSTRAINT "room_calendar_share_generation" CHECK ("room_calendar_share"."membership_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "room_calendar_share" ADD CONSTRAINT "room_calendar_share_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_calendar_share" ADD CONSTRAINT "room_calendar_share_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_calendar_share" ADD CONSTRAINT "room_calendar_share_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;