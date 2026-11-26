CREATE TABLE "export_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"backup_id" text,
	"source_project_id" uuid,
	"format" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text,
	"size_bytes" bigint,
	"sha256" text,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "export_tasks_format_check" CHECK (format IN ('markdown')),
	CONSTRAINT "export_tasks_status_check" CHECK (status IN ('queued','running','ready','failed','expired'))
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "restored_from" jsonb;--> statement-breakpoint
ALTER TABLE "export_tasks" ADD CONSTRAINT "export_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_tasks" ADD CONSTRAINT "export_tasks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_tasks_status_idx" ON "export_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "export_tasks_requested_by_idx" ON "export_tasks" USING btree ("requested_by","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "export_tasks_project_idx" ON "export_tasks" USING btree ("project_id","created_at" DESC NULLS LAST);