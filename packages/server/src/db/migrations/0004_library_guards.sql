-- Hand-written (ADR-0014, data-model.md sections 3 and 6): library guards and the reserved l<n> slug backfill.

-- Edge scope guard: the 0002 body plus the library edge rules, raised as SQLSTATE SPL01 (custom: P0003 is
-- plpgsql's built-in too_many_rows). Refused:
--   (a) conflicts_with, supersedes or drafted_from from a non-library item to a library page;
--   (b) conflicts_with from a library page to a non-library item (stored once, read both ways).
-- Other outgoing links of a library page are a human choice at save time and may point anywhere. The human
-- save path re-resolves wikilinks with an upsert of dst_id, so capture and takeover of library links by
-- later items are refused in the services (claimWikilinks, import), not here.
CREATE OR REPLACE FUNCTION spoor_edge_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src_p uuid; dst_p uuid; shared_p uuid; src_s text; dst_s text;
BEGIN
  SELECT project_id, space INTO src_p, src_s FROM items WHERE id = NEW.src_id;
  SELECT id INTO shared_p FROM projects WHERE kind = 'shared';
  IF NEW.project_id IS DISTINCT FROM src_p THEN
    RAISE EXCEPTION 'edge project must equal source project' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.dst_id IS NOT NULL THEN
    SELECT project_id, space INTO dst_p, dst_s FROM items WHERE id = NEW.dst_id;
    IF dst_p <> src_p AND (dst_p <> shared_p OR src_p = shared_p) THEN
      RAISE EXCEPTION 'edge crosses projects' USING ERRCODE = 'P0002';
    END IF;
    IF dst_s = 'library' AND src_s <> 'library'
       AND NEW.kind IN ('conflicts_with', 'supersedes', 'drafted_from') THEN
      RAISE EXCEPTION 'a library page cannot be the target of %', NEW.kind USING ERRCODE = 'SPL01';
    END IF;
    IF src_s = 'library' AND dst_s <> 'library' AND NEW.kind = 'conflicts_with' THEN
      RAISE EXCEPTION 'a library page cannot conflict with a non-library item' USING ERRCODE = 'SPL01';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- Library content is written by humans in the web UI: a revision of a library page made through MCP or the
-- CLI is refused (SPL02). Every content write appends a revision carrying `via`, so this backstops them all.
CREATE FUNCTION spoor_library_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.via IN ('mcp', 'cli') AND EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND space = 'library') THEN
    RAISE EXCEPTION 'library pages are edited by humans in the web UI' USING ERRCODE = 'SPL02';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER item_revisions_library_guard BEFORE INSERT ON item_revisions
  FOR EACH ROW EXECUTE FUNCTION spoor_library_revision_guard();--> statement-breakpoint

-- `l<n>` is now a handle shape (L3): rename such slugs to `x-l<n>`, as itemSlug does for new items, and the
-- refs of the edges that point at a renamed item. Bodies are not rewritten (revisions are append-only); a
-- body that links [[l<n>]] reads it as a library handle on its next save and must be re-saved as [[x-l<n>]].
DO $$
DECLARE renamed int; kept int; bodies int;
BEGIN
  CREATE TEMP TABLE spoor_l_slug_renamed ON COMMIT DROP AS
    SELECT i.id FROM items i
    WHERE i.slug ~ '^l[0-9]+$' AND length(i.slug) <= 78
      AND NOT EXISTS (
        SELECT 1 FROM items o WHERE o.project_id = i.project_id AND o.space = i.space AND o.slug = 'x-' || i.slug
      );
  UPDATE items SET slug = 'x-' || slug WHERE id IN (SELECT id FROM spoor_l_slug_renamed);
  GET DIAGNOSTICS renamed = ROW_COUNT;
  -- wikilinks store `l7` or `shared:l7`; typed edges into `_shared` store `shared:<space>/l7`
  UPDATE edges e SET dst_ref = regexp_replace(e.dst_ref, '^(shared:(?:[a-z]+/)?)?', '\1x-')
  WHERE e.dst_id IN (SELECT id FROM spoor_l_slug_renamed)
    AND e.dst_ref ~ '^(shared:([a-z]+/)?)?l[0-9]+$'
    AND (e.kind = 'wikilink' OR e.dst_ref LIKE 'shared:%/%')
    AND NOT EXISTS (
      SELECT 1 FROM edges o
      WHERE o.src_id = e.src_id AND o.kind = e.kind
        AND o.dst_ref = regexp_replace(e.dst_ref, '^(shared:(?:[a-z]+/)?)?', '\1x-')
    );
  SELECT count(*) INTO kept FROM items WHERE slug ~ '^l[0-9]+$';
  SELECT count(*) INTO bodies FROM items WHERE body ~* '\[\[(shared:)?\s*l[0-9]+\s*[]#|]';
  RAISE NOTICE 'library_guards: % item slug(s) l<n> renamed to x-l<n>; % not renamed (x- slug taken or too long, still reachable by handle or uuid); % item body(ies) link [[l<n>]] and must be re-saved as [[x-l<n>]]',
    renamed, kept, bodies;
  DROP TABLE spoor_l_slug_renamed;
END $$;
