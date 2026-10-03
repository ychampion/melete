-- A ledger item a connection published names that connection and keeps what it said
-- about the item beyond the ledger's own columns. Removing the connection's row
-- removes its items; revoking it withholds them, which the service checks on read.
ALTER TABLE "ledger_item" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "ledger_item" ADD CONSTRAINT "ledger_item_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_item_connection_idx" ON "ledger_item" USING btree ("connection_id") WHERE "ledger_item"."connection_id" is not null;