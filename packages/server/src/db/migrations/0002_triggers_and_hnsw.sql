-- Hand-written (data-model.md sections 3 and 4): what Drizzle cannot express.

-- append-only revisions and audit log (purge bypass: SET LOCAL spoor.allow_purge = 'on', see spoor_append_only)
CREATE TRIGGER item_revisions_append_only BEFORE UPDATE OR DELETE ON item_revisions
  FOR EACH ROW EXECUTE FUNCTION spoor_append_only();--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION spoor_append_only();--> statement-breakpoint

-- scope guard: an edge belongs to its source's project, and nothing in _shared points out of _shared;
-- a project item may point only into its own project or into _shared
CREATE FUNCTION spoor_edge_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src_p uuid; dst_p uuid; shared_p uuid;
BEGIN
  SELECT project_id INTO src_p FROM items WHERE id = NEW.src_id;
  SELECT id INTO shared_p FROM projects WHERE kind = 'shared';
  IF NEW.project_id IS DISTINCT FROM src_p THEN
    RAISE EXCEPTION 'edge project must equal source project' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.dst_id IS NOT NULL THEN
    SELECT project_id INTO dst_p FROM items WHERE id = NEW.dst_id;
    IF dst_p <> src_p AND (dst_p <> shared_p OR src_p = shared_p) THEN
      RAISE EXCEPTION 'edge crosses projects' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER edges_scope BEFORE INSERT OR UPDATE OF src_id, dst_id, project_id ON edges
  FOR EACH ROW EXECUTE FUNCTION spoor_edge_scope();--> statement-breakpoint

-- Partial expression HNSW index of the default model. The column is untyped, so the index casts to the
-- model's width and is restricted to that model's rows; other models get their own index from the re-embed
-- job. Name = 'chunks_hnsw_' || left(md5(tag), 12).
DO $$
DECLARE tag constant text := 'local:Xenova/multilingual-e5-small@q8/384';
BEGIN
  EXECUTE format(
    'CREATE INDEX %I ON chunks USING hnsw ((embedding::vector(384)) vector_cosine_ops) WITH (m = 16, ef_construction = 64) WHERE model = %L',
    'chunks_hnsw_' || left(md5(tag), 12), tag);
END $$;
