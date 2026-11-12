CREATE TABLE "duplicate_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"new_item_id" uuid NOT NULL,
	"existing_item_id" uuid NOT NULL,
	"cos" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissed_by_label" text,
	CONSTRAINT "duplicate_pairs_pair_uq" UNIQUE("new_item_id","existing_item_id"),
	CONSTRAINT "duplicate_pairs_distinct_check" CHECK (new_item_id <> existing_item_id)
);
--> statement-breakpoint
ALTER TABLE "duplicate_pairs" ADD CONSTRAINT "duplicate_pairs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_pairs" ADD CONSTRAINT "duplicate_pairs_new_item_id_items_id_fk" FOREIGN KEY ("new_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_pairs" ADD CONSTRAINT "duplicate_pairs_existing_item_id_items_id_fk" FOREIGN KEY ("existing_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_pairs" ADD CONSTRAINT "duplicate_pairs_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duplicate_pairs_open_idx" ON "duplicate_pairs" USING btree ("project_id","created_at" DESC NULLS LAST) WHERE dismissed_at IS NULL;--> statement-breakpoint
CREATE INDEX "duplicate_pairs_existing_idx" ON "duplicate_pairs" USING btree ("existing_item_id");