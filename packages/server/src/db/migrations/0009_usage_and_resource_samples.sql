CREATE TABLE "resource_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resource_samples_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"host" text NOT NULL,
	"cpu_percent" real,
	"load_avg1" real NOT NULL,
	"rss_bytes" bigint NOT NULL,
	"heap_used_bytes" bigint NOT NULL,
	"event_loop_delay_ms" real,
	"db_size_bytes" bigint NOT NULL,
	"db_connections" integer NOT NULL,
	"pool_total" integer,
	"pool_waiting" integer,
	"mcp_sessions" integer NOT NULL,
	"embeddings_pending" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resource_samples_at_idx" ON "resource_samples" USING btree ("at");--> statement-breakpoint
CREATE INDEX "item_revisions_created_idx" ON "item_revisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "items_created_idx" ON "items" USING btree ("created_at");