CREATE TABLE "request_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "request_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"surface" text NOT NULL,
	"operation" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"token_id" uuid,
	"token_name" text,
	"token_prefix" text,
	"client_name" text,
	"space" text,
	"memory_type" text,
	"handles" text[] DEFAULT '{}'::text[] NOT NULL,
	"query" text,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "request_log_kind_check" CHECK (kind IN ('read','write')),
	CONSTRAINT "request_log_surface_check" CHECK (surface IN ('mcp','cli')),
	CONSTRAINT "request_log_query_check" CHECK (length(query) <= 200)
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_log_project_idx" ON "request_log" USING btree ("project_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_log_project_kind_idx" ON "request_log" USING btree ("project_id","kind","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_log_at_idx" ON "request_log" USING btree ("at");