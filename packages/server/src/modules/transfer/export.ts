/**
 * Building an export zip (data-model.md section 8): `manifest.json`, one Markdown file per item,
 * `revisions/<id>.jsonl` and `audit.jsonl`. Labels only, never user ids; no chunks, tokens, sessions,
 * memberships, password hashes or device codes. Reads inside one REPEATABLE READ transaction so the files
 * and the manifest describe the same instant.
 */

import { serializeMarkdown } from '@spoor/shared'
import { asc, eq, sql } from 'drizzle-orm'
import { strToU8 } from 'fflate'
import { auditLog, edges, itemRevisions, items } from '../../db/schema.js'
import { type Db, withTx } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import { itemHandle } from '../items/index.js'
import type { ProjectRow } from '../projects/index.js'
import { sha256Hex } from './canonical.js'
import { exportFrontmatter } from './content.js'
import { takeTransferLock } from './import.js'
import { FORMAT } from './schemas.js'
import { writeZip, ZIP_LIMITS } from './zip.js'

/**
 * api.md section 9: more than this uncompressed is 413 with a hint to use `history=0`. Equal to the import
 * cumulative cap by construction (deviations G12, decided 2026-10-20), so every export can be re-imported.
 */
export const EXPORT_MAX_BYTES: number = ZIP_LIMITS.maxTotalBytes
const EXPORT_MAX_LABEL = `${Math.round(EXPORT_MAX_BYTES / (1024 * 1024))} MB`

const TYPED = new Set(['refines', 'supports', 'depends_on', 'conflicts_with'])

export interface ExportResult {
  zip: Uint8Array
  filename: string
  counts: { items: number; revisions: number; edges: number; audit: number }
}

const tooLarge = (message: string) =>
  new ApiError('payload_too_large', { message, hint: 'Export without history: ?history=0' })

const iso = (d: Date | null) => (d === null ? null : d.toISOString())
const pad4 = (n: number) => String(n).padStart(4, '0')
const lines = (rows: unknown[]) =>
  rows.length === 0 ? '' : `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`

export async function buildExport(
  db: Db,
  project: ProjectRow,
  opts: { history: boolean; version: string; now?: Date },
): Promise<ExportResult> {
  const now = opts.now ?? new Date()
  const data = await withTx(
    db,
    async (tx) => {
      await takeTransferLock(tx)
      const itemRows = await tx
        .select()
        .from(items)
        .where(eq(items.projectId, project.id))
        .orderBy(asc(items.number))
      if (itemRows.length * (opts.history ? 2 : 1) + 2 > ZIP_LIMITS.maxEntries) {
        throw tooLarge('The project has too many items for one archive.')
      }
      let estimate = itemRows.reduce((n, i) => n + Buffer.byteLength(i.body) + 600, 0)
      if (opts.history) {
        const res = await tx.execute(
          sql`SELECT coalesce(sum(octet_length(r.body) + octet_length(r.title) + octet_length(r.frontmatter::text)), 0)::text AS n
              FROM item_revisions r JOIN items i ON i.id = r.item_id WHERE i.project_id = ${project.id}`,
        )
        estimate += Number((res.rows[0] as { n: string }).n)
      }
      if (estimate > EXPORT_MAX_BYTES)
        throw tooLarge(`The export would be larger than ${EXPORT_MAX_LABEL} uncompressed.`)
      const edgeRows = await tx
        .select()
        .from(edges)
        .where(eq(edges.projectId, project.id))
        .orderBy(asc(edges.id))
      const revisions = opts.history
        ? await tx
            .select({ r: itemRevisions })
            .from(itemRevisions)
            .innerJoin(items, eq(items.id, itemRevisions.itemId))
            .where(eq(items.projectId, project.id))
            .orderBy(asc(itemRevisions.itemId), asc(itemRevisions.revision))
        : []
      const audit = opts.history
        ? await tx.select().from(auditLog).where(eq(auditLog.projectId, project.id)).orderBy(asc(auditLog.id))
        : []
      return { itemRows, edgeRows, revisions: revisions.map((x) => x.r), audit }
    },
    'repeatable read',
  )

  const byId = new Map(data.itemRows.map((i) => [i.id, i]))
  const handleOf = (i: (typeof data.itemRows)[number]) =>
    itemHandle({ space: i.space as Space, number: i.number, adrNumber: i.adrNumber })

  // typed edges per source, supersede chain per target
  const typed = new Map<string, { kind: string; to: string }[]>()
  const supersedes = new Map<string, string>()
  const drafted = new Map<string, string[]>()
  const supersededBy = new Map<string, (typeof data.itemRows)[number]>()
  for (const e of data.edgeRows) {
    if (TYPED.has(e.kind)) typed.set(e.srcId, [...(typed.get(e.srcId) ?? []), { kind: e.kind, to: e.dstRef }])
    else if (e.kind === 'supersedes') {
      supersedes.set(e.srcId, e.dstRef)
      const src = byId.get(e.srcId)
      if (e.dstId && src) {
        const cur = supersededBy.get(e.dstId)
        if (!cur || src.number < cur.number) supersededBy.set(e.dstId, src)
      }
    } else if (e.kind === 'drafted_from') drafted.set(e.srcId, [...(drafted.get(e.srcId) ?? []), e.dstRef])
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

  const files: Record<string, Uint8Array> = {}
  let total = 0
  const put = (name: string, bytes: Uint8Array, cap: number) => {
    if (bytes.length > cap) throw tooLarge(`${name} is larger than ${cap} bytes.`)
    total += bytes.length
    if (total > EXPORT_MAX_BYTES)
      throw tooLarge(`The export would be larger than ${EXPORT_MAX_LABEL} uncompressed.`)
    files[name] = bytes
  }

  const manifestItems = data.itemRows.map((i) => {
    const space = i.space as Space
    const path =
      space === 'decisions' ? `decisions/${pad4(i.adrNumber ?? 0)}-${i.slug}.md` : `${space}/${i.slug}.md`
    const sb = supersededBy.get(i.id)
    const fm = exportFrontmatter({
      id: i.id,
      space,
      title: i.title,
      tags: i.tags,
      anchors: i.anchors,
      pinned: i.pinned,
      lastVerifiedAt: i.lastVerifiedAt,
      type: i.type,
      confidence: i.confidence,
      status: i.status,
      expiresAt: i.expiresAt,
      adrNumber: i.adrNumber,
      decidedOn: i.decidedOn,
      extras: i.frontmatter,
      relations: [...(typed.get(i.id) ?? [])].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.to, b.to)),
      supersedes: supersedes.get(i.id) ?? null,
      supersededBy: sb ? handleOf(sb) : null,
      draftedFrom: [...(drafted.get(i.id) ?? [])].sort(cmp),
    })
    const bytes = strToU8(serializeMarkdown(fm, i.body))
    put(path, bytes, ZIP_LIMITS.maxEntryBytes)
    return {
      id: i.id,
      space: i.space,
      number: i.number,
      adr_number: i.adrNumber,
      slug: i.slug,
      path,
      revision: i.revision,
      content_sha256: sha256Hex(bytes),
      pinned: i.pinned,
      lifecycle: i.lifecycle,
      provenance: i.provenance,
      last_verified_at: iso(i.lastVerifiedAt),
      last_used_at: iso(i.lastUsedAt),
      expires_at: iso(i.expiresAt),
      stale_since: iso(i.staleSince),
      archived_at: iso(i.archivedAt),
      archive_reason: i.archiveReason,
      status_changed_at: iso(i.statusChangedAt),
      decided_on: i.decidedOn,
      source_path: i.sourcePath,
      push_conflict_at: iso(i.pushConflictAt),
      created_at: iso(i.createdAt),
      created_by_label: i.createdByLabel,
      updated_at: iso(i.updatedAt),
      updated_by_label: i.updatedByLabel,
      client_name: i.clientName,
    }
  })

  const manifestEdges = data.edgeRows.map((e) => ({
    id: e.id,
    src_id: e.srcId,
    kind: e.kind,
    dst_ref: e.dstRef,
    dst_id: e.dstId,
    created_at: iso(e.createdAt),
    created_by_label: e.createdByLabel,
    client_name: e.clientName,
  }))

  if (opts.history) {
    const perItem = new Map<string, unknown[]>()
    for (const r of data.revisions) {
      const row = {
        revision: r.revision,
        title: r.title,
        body: r.body,
        status: r.status,
        frontmatter: r.frontmatter,
        change: r.change,
        actor_label: r.actorLabel,
        via: r.via,
        client_name: r.clientName,
        imported_from: r.importedFrom,
        created_at: iso(r.createdAt),
      }
      perItem.set(r.itemId, [...(perItem.get(r.itemId) ?? []), row])
    }
    for (const i of data.itemRows)
      put(`revisions/${i.id}.jsonl`, strToU8(lines(perItem.get(i.id) ?? [])), ZIP_LIMITS.maxEntryBytes)
    put(
      'audit.jsonl',
      strToU8(
        lines(
          data.audit.map((a) => ({
            at: iso(a.at),
            actor_label: a.actorLabel,
            via: a.via,
            client_name: a.clientName,
            action: a.action,
            item_id: a.itemId,
            item_handle: a.itemHandle,
            summary: a.summary,
            data: a.data,
          })),
        ),
      ),
      ZIP_LIMITS.maxEntryBytes,
    )
  }

  const manifest = {
    format: FORMAT,
    exported_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    spoor_version: opts.version,
    history: opts.history,
    project: {
      id: project.id,
      kind: project.kind,
      slug: project.slug,
      name: project.name,
      description: project.description,
      settings: project.settings,
      next_item_number: project.nextItemNumber,
      next_adr_number: project.nextAdrNumber,
    },
    items: manifestItems,
    edges: manifestEdges,
  }
  put('manifest.json', strToU8(`${JSON.stringify(manifest, null, 2)}\n`), ZIP_LIMITS.maxManifestBytes)

  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  return {
    zip: writeZip(files, now),
    filename: `spoor-${project.slug}-${day}.zip`,
    counts: {
      items: data.itemRows.length,
      revisions: data.revisions.length,
      edges: data.edgeRows.length,
      audit: data.audit.length,
    },
  }
}
