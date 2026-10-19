-- Hand-written (data-model.md section 1). Extensions are normally created earlier by the superuser connection
-- (DATABASE_MIGRATE_URL); IF NOT EXISTS makes this a no-op for the runtime role then.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint

-- unaccent(text) is STABLE; generated columns and index expressions need IMMUTABLE.
CREATE FUNCTION spoor_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;--> statement-breakpoint

-- append-only guard for item_revisions and audit_log; purge bypass for human hard-delete only
-- (the purge transaction runs SET LOCAL spoor.allow_purge = 'on'; nothing else sets it)
CREATE FUNCTION spoor_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('spoor.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
