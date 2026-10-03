CREATE TABLE "sandbox_awake_day" (
	"space_id" text NOT NULL,
	"day" date NOT NULL,
	"seconds" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "sandbox_awake_day_space_id_day_pk" PRIMARY KEY("space_id","day")
);
--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD COLUMN "held_by" text;--> statement-breakpoint
ALTER TABLE "sandbox_awake_day" ADD CONSTRAINT "sandbox_awake_day_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_held_by_check" CHECK ("sandbox_session"."held_by" is null or "sandbox_session"."held_by" in ('attempt', 'processes'));