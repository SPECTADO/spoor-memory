/**
 * The Markdown zip (ADR-0041, api.md section 13.4): one code path for a live project and for a project archive
 * inside a backup. Both arrive as a parsed `spoor-export/1` archive (archive.ts `parseArchive`), so the files
 * are exactly what `buildExport` writes for the same items: the canonical export frontmatter and the body.
 *
 * Layout, flat and manifest-less so it re-imports as a folder of Markdown files: a root `README.md` (an index
 * the importer skips), `memories/<slug>.md`, `decisions/<NNNN>-<slug>.md`, `docs/<slug>.md`,
 * `library/<slug>.md`. Pure: no database, no disk.
 */
import { markdownZipFileName, serializeMarkdown } from '@spoor/shared'
import { strToU8 } from 'fflate'
import { MEMORY_TYPES } from '../../db/schema.js'
import type { Space } from '../../ports.js'
import { itemHandle } from '../items/index.js'
import { type LosslessArchive, type ParsedArchive, type PlannedItem, README_ENTRY } from './archive.js'
import { exportFrontmatter } from './content.js'
import { invalidArchive } from './errors.js'
import { edgeFrontmatter } from './export.js'
import { writeZip } from './zip.js'

/** Where the archive came from, printed in the README. */
export type MarkdownSource =
  | { kind: 'live' }
  | {
      kind: 'backup'
      backupId: string
      /** The backup's `created_at` (ISO), when known. */
      backupCreatedAt?: string | null
    }

export interface MarkdownZip {
  zip: Uint8Array
  /** `spoor-<slug>-markdown-<YYYYMMDD>.zip` of `now`. */
  fileName: string
  counts: { items: number; active: number; inactive: number; bySpace: Record<Space, number> }
}

const SPACE_ORDER: readonly Space[] = ['memories', 'decisions', 'docs', 'library']
const SPACE_TITLE: Record<Space, string> = {
  memories: 'Memories',
  decisions: 'Decisions (ADRs)',
  docs: 'Docs',
  library: 'Library',
}
const TYPE_TITLE: Record<(typeof MEMORY_TYPES)[number], string> = {
  decision: 'Decision notes',
  fact: 'Facts',
  procedure: 'Procedures',
  observation: 'Observations',
}

const pad4 = (n: number) => String(n).padStart(4, '0')

/** The path of an item in the zip: the same as in an export archive. */
export function markdownPath(m: { space: Space; slug: string; adr_number: number | null }): string {
  return m.space === 'decisions'
    ? `decisions/${pad4(m.adr_number ?? 0)}-${m.slug}.md`
    : `${m.space}/${m.slug}.md`
}

/** Search's rule (search/service.ts): archived, superseded and deprecated items are inactive. */
export function isInactive(i: PlannedItem): boolean {
  return (
    i.m.lifecycle === 'archived' || i.content.status === 'superseded' || i.content.status === 'deprecated'
  )
}

/** A table cell: Markdown punctuation escaped, one line. */
export function cell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\|`*_[\]<>])/g, '\\$1')
}

/** A relative link target: the path segments are URL-safe already (`[a-z0-9-]`), the dot and slash stay. */
const link = (path: string) => `[${path}](${encodeURI(path)})`

function sortItems(list: PlannedItem[]): PlannedItem[] {
  return [...list].sort(
    (a, b) =>
      SPACE_ORDER.indexOf(a.m.space) - SPACE_ORDER.indexOf(b.m.space) ||
      (a.m.adr_number ?? 0) - (b.m.adr_number ?? 0) ||
      a.m.number - b.m.number,
  )
}

function table(rows: PlannedItem[], handle: (i: PlannedItem) => string, withSpace = false): string[] {
  const head = withSpace
    ? ['| Handle | Space | Title | Status | Lifecycle | File |', '|---|---|---|---|---|---|']
    : ['| Handle | Title | Status | File |', '|---|---|---|---|']
  return [
    ...head,
    ...sortItems(rows).map((i) =>
      withSpace
        ? `| ${cell(handle(i))} | ${i.m.space} | ${cell(i.content.title)} | ${i.content.status} | ${i.m.lifecycle} | ${link(markdownPath(i.m))} |`
        : `| ${cell(handle(i))} | ${cell(i.content.title)} | ${i.content.status} | ${link(markdownPath(i.m))} |`,
    ),
  ]
}

function readme(
  a: LosslessArchive,
  source: MarkdownSource,
  now: Date,
  counts: MarkdownZip['counts'],
): string {
  const p = a.manifest.project
  const shared = p.kind === 'shared'
  const handle = (i: PlannedItem) =>
    itemHandle({ space: i.m.space, number: i.m.number, adrNumber: i.m.adr_number }, shared)
  const active = a.items.filter((i) => !isInactive(i))
  const inactive = a.items.filter(isInactive)
  const src =
    source.kind === 'live'
      ? 'the live project'
      : `backup \`${source.backupId}\`${source.backupCreatedAt ? ` (taken ${source.backupCreatedAt})` : ''}`
  const out: string[] = [
    `# ${cell(p.name)}`,
    '',
    `Markdown export of the Spoor project \`${p.slug}\`.`,
    '',
    `- Source: ${src}`,
    `- Exported: ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `- Items: ${counts.items} (${counts.active} active, ${counts.inactive} inactive): ${SPACE_ORDER.map(
      (s) => `${counts.bySpace[s]} ${s}`,
    ).join(', ')}`,
    '',
    'Every item is one Markdown file with its frontmatter. The zip re-imports into Spoor as a folder of Markdown',
    'files (every file becomes a new item); this README is skipped on import.',
  ]
  for (const space of SPACE_ORDER) {
    const inSpace = active.filter((i) => i.m.space === space)
    if (inSpace.length === 0) continue
    out.push('', `## ${SPACE_TITLE[space]}`)
    if (space === 'memories') {
      for (const type of MEMORY_TYPES) {
        const ofType = inSpace.filter((i) => i.content.type === type)
        if (ofType.length === 0) continue
        out.push('', `### ${TYPE_TITLE[type]}`, '', ...table(ofType, handle))
      }
    } else {
      out.push('', ...table(inSpace, handle))
    }
  }
  if (inactive.length > 0) {
    out.push(
      '',
      '## Inactive items',
      '',
      'Archived, superseded and deprecated items: kept for the record, not used by search or context.',
      '',
      ...table(inactive, handle, true),
    )
  }
  return `${out.join('\n')}\n`
}

/** The file of one item: the canonical export frontmatter and the body (what `buildExport` writes). */
function itemFile(i: PlannedItem, edgeFm: ReturnType<typeof edgeFrontmatter>): Uint8Array {
  const { m, content: c } = i
  const fm = exportFrontmatter({
    id: m.id,
    space: m.space,
    title: c.title,
    tags: c.tags,
    anchors: c.anchors,
    pinned: m.pinned,
    lastVerifiedAt: new Date(m.last_verified_at),
    type: c.type,
    confidence: c.confidence,
    status: c.status,
    expiresAt: m.expires_at === null ? null : new Date(m.expires_at),
    adrNumber: m.adr_number,
    decidedOn: i.decidedOn,
    extras: c.extras,
    ...edgeFm(m.id),
  })
  return strToU8(serializeMarkdown(fm, c.body))
}

/**
 * Build the Markdown zip of a parsed export archive. Only a `spoor-export/1` archive (with a manifest) has the
 * numbers, lifecycle and edges the files and the index need; both sources always are one.
 */
export function markdownZip(
  parsed: ParsedArchive,
  source: MarkdownSource,
  opts: { now?: Date } = {},
): MarkdownZip {
  if (parsed.kind !== 'lossless') {
    throw invalidArchive('A Markdown zip needs a Spoor export archive with manifest.json.')
  }
  const now = opts.now ?? new Date()
  const edgeFm = edgeFrontmatter(
    parsed.items.map((i) => ({
      id: i.m.id,
      space: i.m.space,
      number: i.m.number,
      adrNumber: i.m.adr_number,
    })),
    parsed.edges.map((e) => ({ srcId: e.src_id, kind: e.kind, dstRef: e.dst_ref, dstId: e.dst_id })),
  )
  // the README first in the zip (a reader opening it sees the index on top); filled in below
  const files: Record<string, Uint8Array> = { [README_ENTRY]: new Uint8Array() }
  const bySpace: Record<Space, number> = { memories: 0, decisions: 0, docs: 0, library: 0 }
  let inactive = 0
  for (const i of parsed.items) {
    files[markdownPath(i.m)] = itemFile(i, edgeFm)
    bySpace[i.m.space]++
    if (isInactive(i)) inactive++
  }
  const counts = { items: parsed.items.length, active: parsed.items.length - inactive, inactive, bySpace }
  files[README_ENTRY] = strToU8(readme(parsed, source, now, counts))
  return {
    zip: writeZip(files, now),
    fileName: markdownZipFileName(parsed.manifest.project.slug, now),
    counts,
  }
}
