-- One superseder per item (data-model.md section 3). Before 0.7 two concurrent supersedes of one item could
-- both succeed and leave two live successors. Repair first: per target, the earliest supersedes edge stays;
-- each later one becomes a `refines` edge (the later item still refines the old claim), or is deleted when
-- that `refines` edge already exists. Statuses are left as they are. Then the partial unique index.
DO $$
DECLARE
  demoted integer;
  deleted integer;
BEGIN
  UPDATE edges e SET kind = 'refines'
   WHERE e.kind = 'supersedes' AND e.dst_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM edges f
                  WHERE f.kind = 'supersedes' AND f.dst_id = e.dst_id
                    AND (f.created_at, f.id) < (e.created_at, e.id))
     AND NOT EXISTS (SELECT 1 FROM edges r
                      WHERE r.src_id = e.src_id AND r.kind = 'refines' AND r.dst_ref = e.dst_ref);
  GET DIAGNOSTICS demoted = ROW_COUNT;
  DELETE FROM edges e
   WHERE e.kind = 'supersedes' AND e.dst_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM edges f
                  WHERE f.kind = 'supersedes' AND f.dst_id = e.dst_id
                    AND (f.created_at, f.id) < (e.created_at, e.id));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF demoted + deleted > 0 THEN
    RAISE NOTICE 'edges_one_superseder: % extra supersedes edge(s) turned into refines, % deleted', demoted, deleted;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "edges_one_superseder_uq" ON "edges" USING btree ("dst_id") WHERE kind = 'supersedes';
