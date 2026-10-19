CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"project_id" uuid,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"token_id" uuid,
	"via" text NOT NULL,
	"client_name" text,
	"action" text NOT NULL,
	"item_id" uuid,
	"item_handle" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_via_check" CHECK (via IN ('web','mcp','cli','import','system')),
	CONSTRAINT "audit_log_summary_check" CHECK (length(summary) <= 300)
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"space" text NOT NULL,
	"ordinal" integer NOT NULL,
	"item_revision" integer NOT NULL,
	"text" text NOT NULL,
	"model" text NOT NULL,
	"dims" smallint NOT NULL,
	"embedding" vector,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', spoor_unaccent(text))) STORED,
	CONSTRAINT "chunks_item_model_ordinal_uq" UNIQUE("item_id","model","ordinal"),
	CONSTRAINT "chunks_ordinal_check" CHECK (ordinal >= 0),
	CONSTRAINT "chunks_dims_check" CHECK (dims BETWEEN 1 AND 2000),
	CONSTRAINT "chunks_embedding_dims_check" CHECK (embedding IS NULL OR vector_dims(embedding) = dims)
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" "bytea" NOT NULL,
	"user_code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role_cap" text,
	"user_id" uuid,
	"token_id" uuid,
	"interval_s" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"requester_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "device_codes_device_code_hash_key" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_check" CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
	CONSTRAINT "device_codes_client_name_check" CHECK (length(client_name) BETWEEN 1 AND 64),
	CONSTRAINT "device_codes_status_check" CHECK (status IN ('pending','approved','denied','consumed')),
	CONSTRAINT "device_codes_role_cap_check" CHECK (role_cap IN ('editor','viewer')),
	CONSTRAINT "device_codes_requester_ip_check" CHECK (length(requester_ip) <= 45)
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"src_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dst_ref" text NOT NULL,
	"dst_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_by_label" text,
	"client_name" text,
	CONSTRAINT "edges_src_kind_dst_ref_uq" UNIQUE("src_id","kind","dst_ref"),
	CONSTRAINT "edges_kind_check" CHECK (kind IN ('refines','supports','depends_on','conflicts_with','supersedes','drafted_from','wikilink')),
	CONSTRAINT "edges_no_self_loop_check" CHECK (src_id <> dst_id)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"email" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"shared_editor" boolean DEFAULT false NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"revoked_at" timestamp with time zone,
	"reset_user_id" uuid,
	"reset_revoke_tokens" boolean DEFAULT true NOT NULL,
	CONSTRAINT "invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "invites_email_check" CHECK (email = lower(btrim(email))),
	CONSTRAINT "invites_reset_check" CHECK (reset_user_id IS NULL OR (grants = '[]'::jsonb AND NOT is_admin AND NOT shared_editor))
);
--> statement-breakpoint
CREATE TABLE "item_revisions" (
	"item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"change" text NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"token_id" uuid,
	"via" text NOT NULL,
	"client_name" text,
	"imported_from" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_revisions_item_id_revision_pk" PRIMARY KEY("item_id","revision"),
	CONSTRAINT "item_revisions_change_check" CHECK (change IN ('create','update','status','supersede','import','push')),
	CONSTRAINT "item_revisions_via_check" CHECK (via IN ('web','mcp','cli','import','system'))
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"space" text NOT NULL,
	"number" integer NOT NULL,
	"adr_number" integer,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" text,
	"status" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"confidence" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"anchors" text[] DEFAULT '{}'::text[] NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"decided_on" date,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_path" text,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"stale_since" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archive_reason" text,
	"push_conflict_at" timestamp with time zone,
	"provenance" text DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_by_label" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_by_label" text NOT NULL,
	"client_name" text,
	CONSTRAINT "items_project_space_slug_uq" UNIQUE("project_id","space","slug"),
	CONSTRAINT "items_project_number_uq" UNIQUE("project_id","number"),
	CONSTRAINT "items_space_check" CHECK (space IN ('memories','decisions','docs')),
	CONSTRAINT "items_adr_number_check" CHECK (adr_number BETWEEN 1 AND 99999),
	CONSTRAINT "items_slug_check" CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80),
	CONSTRAINT "items_title_check" CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '[\r\n]'),
	CONSTRAINT "items_lifecycle_check" CHECK (lifecycle IN ('active','stale','archived')),
	CONSTRAINT "items_confidence_check" CHECK (confidence IN ('low','medium','high')),
	CONSTRAINT "items_body_check" CHECK (length(body) <= 200000),
	CONSTRAINT "items_archive_reason_check" CHECK (archive_reason IN ('stale','expired','manual')),
	CONSTRAINT "items_provenance_check" CHECK (provenance IN ('human','agent')),
	CONSTRAINT "items_client_name_check" CHECK (length(client_name) <= 64),
	CONSTRAINT "items_decision_adr_check" CHECK ((space = 'decisions') = (adr_number IS NOT NULL)),
	CONSTRAINT "items_memory_shape_check" CHECK ((space = 'memories') = (type IS NOT NULL AND confidence IS NOT NULL)),
	CONSTRAINT "items_memory_type_check" CHECK (space <> 'memories' OR type IN ('decision','fact','procedure','observation')),
	CONSTRAINT "items_status_check" CHECK (CASE space WHEN 'decisions' THEN status IN ('proposed','accepted','superseded','deprecated') ELSE status IN ('active','superseded') END),
	CONSTRAINT "items_observation_expiry_check" CHECK ((type = 'observation') = (expires_at IS NOT NULL)),
	CONSTRAINT "items_stale_check" CHECK ((lifecycle = 'stale') = (stale_since IS NOT NULL)),
	CONSTRAINT "items_archived_check" CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL AND archive_reason IS NOT NULL)),
	CONSTRAINT "items_array_limits_check" CHECK (cardinality(tags) <= 20 AND cardinality(anchors) <= 20)
);
--> statement-breakpoint
CREATE TABLE "job_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone DEFAULT '-infinity' NOT NULL,
	"locked_by" text,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	CONSTRAINT "job_locks_last_status_check" CHECK (last_status IN ('ok','error'))
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"project_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "job_runs_status_check" CHECK (status IN ('running','ok','error'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK (role IN ('admin','editor','viewer'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'project' NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_item_number" integer DEFAULT 1 NOT NULL,
	"next_adr_number" integer DEFAULT 1 NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_target" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_key" UNIQUE("slug"),
	CONSTRAINT "projects_kind_check" CHECK (kind IN ('project','shared')),
	CONSTRAINT "projects_name_check" CHECK (length(name) BETWEEN 1 AND 100),
	CONSTRAINT "projects_description_check" CHECK (length(description) <= 2000),
	CONSTRAINT "projects_next_item_number_check" CHECK (next_item_number >= 1),
	CONSTRAINT "projects_next_adr_number_check" CHECK (next_adr_number >= 1),
	CONSTRAINT "projects_slug_check" CHECK ((kind = 'shared' AND slug = '_shared') OR (kind = 'project' AND slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	CONSTRAINT "sessions_user_agent_check" CHECK (length(user_agent) <= 300)
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"prefix" text NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"role" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"origin" text DEFAULT 'web' NOT NULL,
	CONSTRAINT "tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "tokens_kind_check" CHECK (kind IN ('user','service')),
	CONSTRAINT "tokens_name_check" CHECK (length(name) BETWEEN 1 AND 100),
	CONSTRAINT "tokens_role_check" CHECK (role IN ('editor','viewer')),
	CONSTRAINT "tokens_origin_check" CHECK (origin IN ('web','device')),
	CONSTRAINT "tokens_kind_shape_check" CHECK ((kind = 'user' AND user_id IS NOT NULL) OR (kind = 'service' AND user_id IS NULL AND role IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"shared_editor" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_check" CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
	CONSTRAINT "users_name_check" CHECK (length(name) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_id_items_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_id_items_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_reset_user_id_users_id_fk" FOREIGN KEY ("reset_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_revisions" ADD CONSTRAINT "item_revisions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_project_idx" ON "audit_log" USING btree ("project_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_item_idx" ON "audit_log" USING btree ("item_id","at" DESC NULLS LAST) WHERE item_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_scope_idx" ON "chunks" USING btree ("project_id","model","space");--> statement-breakpoint
CREATE INDEX "chunks_pending_idx" ON "chunks" USING btree ("model") WHERE embedding IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_live_user_code" ON "device_codes" USING btree ("user_code") WHERE status IN ('pending','approved');--> statement-breakpoint
CREATE INDEX "device_codes_pending_idx" ON "device_codes" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "edges_dst_idx" ON "edges" USING btree ("dst_id","kind");--> statement-breakpoint
CREATE INDEX "edges_dangling_idx" ON "edges" USING btree ("project_id","dst_ref") WHERE dst_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "items_adr_uq" ON "items" USING btree ("project_id","adr_number") WHERE adr_number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "items_source_uq" ON "items" USING btree ("project_id","source_path") WHERE source_path IS NOT NULL;--> statement-breakpoint
CREATE INDEX "items_browse_idx" ON "items" USING btree ("project_id","space","lifecycle","status");--> statement-breakpoint
CREATE INDEX "items_updated_idx" ON "items" USING btree ("project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_verified_idx" ON "items" USING btree ("project_id","last_verified_at" DESC NULLS LAST) WHERE lifecycle = 'active';--> statement-breakpoint
CREATE INDEX "items_pinned_idx" ON "items" USING btree ("project_id") WHERE pinned;--> statement-breakpoint
CREATE INDEX "items_tags_gin" ON "items" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "items_anchored_idx" ON "items" USING btree ("project_id") WHERE cardinality(anchors) > 0;--> statement-breakpoint
CREATE INDEX "items_cleanup_idx" ON "items" USING btree ("project_id","lifecycle") WHERE space = 'memories';--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "job_runs" USING btree ("name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_single_shared" ON "projects" USING btree ("kind") WHERE kind = 'shared';--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tokens_project_idx" ON "tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tokens_user_idx" ON "tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");