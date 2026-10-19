/**
 * Archive parsing and validation (data-model.md section 8, auth-and-security.md section 9). Pure: takes the
 * entries of a hardened unzip (zip.ts) and returns what the importer writes, or throws `invalid_archive`.
 *
 * Two kinds of archive: with `manifest.json` (lossless: ids, revisions, edges, numbering all come from it)
 * and without (a folder of Markdown files: every file becomes a new item).
 *
 * Provenance in the archive is untrusted text. Here every actor label becomes `imported: <label>` and the
 * original `{via, actor_label, token_id, client_name}` is kept in `imported_from`; no user id exists.
 */
import { cleanLine, frontmatterSchemas } from '@spoor/shared'
import type { Space } from '../../ports.js'
import { canonicalFrontmatter, sameContent } from '../items/index.js'
import { readMarkdown, sha256Hex } from './canonical.js'
import { type Content, contentFrom } from './content.js'
import { type ArchiveIssue, invalidArchive, shortName } from './errors.js'
import {
  type AuditLine,
  auditLine,
  type Manifest,
  type ManifestEdge,
  type ManifestItem,
  manifest as manifestSchema,
  type RevisionLine,
  revisionLine,
} from './schemas.js'

/** Names an import accepts (data-model.md section 8). */
export const ENTRY_ALLOWLIST: RegExp[] = [
  /^manifest\.json$/,
  /^audit\.jsonl$/,
  /^(?:memories|docs)\/[a-z0-9-]{1,80}\.md$/,
  /^decisions\/\d{4,5}-[a-z0-9-]{1,80}\.md$/,
  /^revisions\/[0-9a-f-]{36}\.jsonl$/,
]
export const entryAllowed = (name: string) => ENTRY_ALLOWLIST.some((re) => re.test(name))

const utf8 = new TextDecoder('utf-8', { fatal: true })

function decode(name: string, bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes)
  } catch {
    throw invalidArchive('An entry is not valid UTF-8.', [
      { path: shortName(name), message: 'invalid UTF-8' },
    ])
  }
}

function issuesOf(
  error: { issues: { path: PropertyKey[]; message: string }[] },
  prefix: string,
): ArchiveIssue[] {
  return error.issues.slice(0, 20).map((i) => ({
    path: `${prefix}${i.path.length ? `.${i.path.map(String).join('.')}` : ''}`,
    message: i.message,
  }))
}

export const IMPORT_PREFIX = 'imported: '

/** `imported: <label>` (kept as is when it already starts so), control characters stripped. */
export function importedLabel(label: string): string {
  const clean = cleanLine(label) || 'unknown'
  return clean.startsWith(IMPORT_PREFIX) ? clean : `${IMPORT_PREFIX}${clean}`
}

export function cleanClient(c: string | null): string | null {
  if (c === null) return null
  const v = cleanLine(c).slice(0, 64)
  return v === '' ? null : v
}

export interface PlannedRevision {
  revision: number
  title: string
  body: string
  status: string
  frontmatter: Record<string, unknown>
  change: RevisionLine['change']
  /** always `imported: ...` */
  actorLabel: string
  /** always `import` */
  via: 'import'
  clientName: string | null
  importedFrom: Record<string, unknown> | null
  createdAt: Date
}

export interface PlannedItem {
  m: ManifestItem
  content: Content
  /** final revision number (manifest revision, +1 when an edited file was appended) */
  revision: number
  decidedOn: string | null
  updatedAt: Date
  updatedByLabel: string
  statusChangedAt: Date
  revisions: PlannedRevision[]
  /** an edited Markdown file produced one extra revision */
  appended: boolean
}

export interface PlannedAudit {
  at: Date
  actorLabel: string
  clientName: string | null
  action: string
  itemId: string | null
  itemHandle: string | null
  summary: string
  data: Record<string, unknown>
}

export interface LosslessArchive {
  kind: 'lossless'
  manifest: Manifest
  items: PlannedItem[]
  edges: ManifestEdge[]
  audit: PlannedAudit[]
  notes: string[]
}

export interface FileItem {
  path: string
  space: Space
  slug: string
  adr: number | null
  content: Content
  pinned: boolean
  lastVerified: Date | null
  decidedOn: string | null
  spoorId: string | null
  relations: { kind: string; to: string }[]
  supersedes: string | null
  draftedFrom: string[]
  clientName: null
}

export interface FilesArchive {
  kind: 'files'
  files: FileItem[]
  notes: string[]
}

export type ParsedArchive = LosslessArchive | FilesArchive

const mdPath = (m: ManifestItem) =>
  m.space === 'decisions'
    ? `decisions/${String(m.adr_number ?? 0).padStart(4, '0')}-${m.slug}.md`
    : `${m.space}/${m.slug}.md`

function jsonLines<T>(name: string, bytes: Uint8Array, parse: (raw: unknown, line: number) => T): T[] {
  const text = decode(name, bytes)
  const out: T[] = []
  let n = 0
  for (const line of text.split('\n')) {
    n++
    if (line === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw invalidArchive('A JSONL line is not valid JSON.', [
        { path: `${shortName(name)}:${n}`, message: 'invalid JSON' },
      ])
    }
    out.push(parse(raw, n))
  }
  return out
}

/** The revision snapshot of the item module (`canonicalFrontmatter`): one shape whoever writes the row. */
const snapshot = (m: ManifestItem, decidedOn: string | null, c: Content) =>
  canonicalFrontmatter({ id: m.id, space: m.space, adrNumber: m.adr_number, decidedOn, ...c })

function checkState(m: ManifestItem, c: Content): void {
  const where = shortName(m.path)
  const bad = (message: string): never => {
    throw invalidArchive(`${where}: ${message}`, [{ path: where, message }])
  }
  if ((m.space === 'decisions') !== (m.adr_number !== null))
    bad('adr_number must be set exactly for decisions')
  if ((c.type === 'observation') !== (m.expires_at !== null))
    bad('expires_at must be set exactly for observations')
  if ((m.lifecycle === 'stale') !== (m.stale_since !== null))
    bad('stale_since must be set exactly when stale')
  if ((m.lifecycle === 'archived') !== (m.archived_at !== null && m.archive_reason !== null))
    bad('archive fields must be set exactly when archived')
  // a pin clears stale and the lifecycle predicates skip pinned items: such an item would stay stale forever
  if (m.pinned && m.lifecycle === 'stale') bad('a pinned item cannot be stale')
}

function provenanceOfRevision(
  l: RevisionLine,
): Pick<PlannedRevision, 'actorLabel' | 'via' | 'clientName' | 'importedFrom'> {
  const actorLabel = importedLabel(l.actor_label)
  if (l.via === 'import' && l.imported_from) {
    return {
      actorLabel,
      via: 'import',
      clientName: cleanClient(l.client_name),
      importedFrom: l.imported_from,
    }
  }
  return {
    actorLabel,
    via: 'import',
    clientName: cleanClient(l.client_name),
    importedFrom: {
      via: l.via,
      actor_label: cleanLine(l.actor_label),
      token_id: null,
      client_name: cleanClient(l.client_name),
    },
  }
}

function parseLossless(entries: Map<string, Uint8Array>): LosslessArchive {
  const raw = entries.get('manifest.json')
  if (!raw) throw invalidArchive('manifest.json is missing.')
  const manifestText = decode('manifest.json', raw)
  let json: unknown
  try {
    json = JSON.parse(manifestText)
  } catch {
    throw invalidArchive('manifest.json is not valid JSON.')
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) throw invalidArchive('manifest.json is invalid.', issuesOf(parsed.error, 'manifest'))
  const manifest = parsed.data
  const notes: string[] = []

  // uniqueness inside the manifest (the DB would reject these; report them as an archive problem)
  const ids = new Set<string>()
  const slugs = new Set<string>()
  const numbers = new Set<number>()
  const adrs = new Set<number>()
  const sources = new Set<string>()
  const paths = new Set<string>()
  for (const m of manifest.items) {
    const dup = (what: string): never => {
      throw invalidArchive(`Duplicate ${what} in the manifest.`, [
        { path: shortName(m.path), message: `duplicate ${what}` },
      ])
    }
    if (ids.has(m.id)) dup('id')
    ids.add(m.id)
    if (slugs.has(`${m.space}/${m.slug}`)) dup('slug')
    slugs.add(`${m.space}/${m.slug}`)
    if (numbers.has(m.number)) dup('number')
    numbers.add(m.number)
    if (m.adr_number !== null) {
      if (adrs.has(m.adr_number)) dup('adr_number')
      adrs.add(m.adr_number)
    }
    if (m.source_path !== null) {
      if (sources.has(m.source_path)) dup('source_path')
      sources.add(m.source_path)
    }
    if (m.path !== mdPath(m)) {
      throw invalidArchive('An item path does not match its space, slug and number.', [
        { path: shortName(m.path), message: 'unexpected path' },
      ])
    }
    if (paths.has(m.path)) dup('path')
    paths.add(m.path)
  }

  // entries must be exactly the ones the manifest names
  for (const name of entries.keys()) {
    if (name === 'manifest.json') continue
    if (name === 'audit.jsonl') {
      if (!manifest.history)
        throw invalidArchive('audit.jsonl present but the manifest says history is false.')
      continue
    }
    if (name.startsWith('revisions/')) {
      const id = name.slice('revisions/'.length, -'.jsonl'.length)
      if (!manifest.history) throw invalidArchive('revisions present but the manifest says history is false.')
      if (!ids.has(id))
        throw invalidArchive('A revisions file names an item that is not in the manifest.', [
          { path: shortName(name), message: 'unknown item' },
        ])
      continue
    }
    if (!paths.has(name))
      throw invalidArchive('A Markdown file is not listed in the manifest.', [
        { path: shortName(name), message: 'not in manifest' },
      ])
  }
  if (manifest.history && !entries.has('audit.jsonl'))
    throw invalidArchive('audit.jsonl is missing although history is true.')

  const items: PlannedItem[] = []
  for (const m of manifest.items) {
    const fileBytes = entries.get(m.path)
    if (!fileBytes)
      throw invalidArchive('A Markdown file listed in the manifest is missing.', [
        { path: shortName(m.path), message: 'missing' },
      ])
    const fileText = decode(m.path, fileBytes)
    const hashOk = sha256Hex(fileBytes) === m.content_sha256
    const defaultStatus = m.space === 'decisions' ? 'accepted' : 'active'
    const { fm, body } = readMarkdown(fileText, m.path)
    const fromFile = () => contentFrom(m.space, fm, { path: m.path, body, defaultStatus })

    let revisions: PlannedRevision[] = []
    let content: Content
    let appended = false
    let revision = m.revision
    let updatedAt = new Date(m.updated_at)
    let updatedByLabel = importedLabel(m.updated_by_label)
    let statusChangedAt = new Date(m.status_changed_at)
    let decidedOn = m.decided_on

    if (manifest.history) {
      const name = `revisions/${m.id}.jsonl`
      const rb = entries.get(name)
      if (!rb)
        throw invalidArchive('A revisions file is missing.', [{ path: shortName(name), message: 'missing' }])
      const lines = jsonLines(name, rb, (r, n) => {
        const p = revisionLine.safeParse(r)
        if (!p.success)
          throw invalidArchive('A revision line is invalid.', issuesOf(p.error, `${shortName(name)}:${n}`))
        return p.data
      })
      if (lines.length === 0)
        throw invalidArchive('A revisions file is empty.', [{ path: shortName(name), message: 'empty' }])
      let prev = 0
      for (const l of lines) {
        if (l.revision <= prev)
          throw invalidArchive('Revisions must be strictly ascending.', [
            { path: shortName(name), message: 'not ascending' },
          ])
        prev = l.revision
      }
      const last = lines[lines.length - 1] as RevisionLine
      if (last.revision !== m.revision) {
        throw invalidArchive('The last revision differs from the item revision.', [
          { path: shortName(name), message: `last revision ${last.revision}, item ${m.revision}` },
        ])
      }
      revisions = lines.map((l) => ({
        revision: l.revision,
        title: cleanLine(l.title) || l.title,
        body: l.body,
        status: l.status,
        frontmatter: l.frontmatter,
        change: l.change,
        ...provenanceOfRevision(l),
        createdAt: new Date(l.created_at),
      }))
      content = contentFrom(m.space, last.frontmatter, {
        path: name,
        body: last.body,
        title: last.title,
        status: last.status,
        defaultStatus,
      })
      if (!hashOk) {
        const edited = contentFrom(m.space, fm, {
          path: m.path,
          body,
          titleFallback: content.title,
          defaultStatus,
        })
        // a decision's `date:` is content too (review C6): an edit of only the date is a new revision
        const editedDecidedOn =
          m.space === 'decisions' && typeof fm.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fm.date)
            ? fm.date
            : decidedOn
        if (!sameContent({ ...edited, decidedOn: editedDecidedOn }, { ...content, decidedOn })) {
          appended = true
          revision = m.revision + 1
          const now = new Date()
          if (edited.status !== content.status) statusChangedAt = now
          decidedOn = editedDecidedOn
          content = edited
          updatedAt = now
          updatedByLabel = `${IMPORT_PREFIX}archive edit`
          revisions.push({
            revision,
            title: edited.title,
            body: edited.body,
            status: edited.status,
            frontmatter: snapshot(m, decidedOn, edited),
            change: 'import',
            actorLabel: updatedByLabel,
            via: 'import',
            clientName: null,
            importedFrom: { via: 'import', actor_label: 'archive edit', token_id: null, client_name: null },
            createdAt: now,
          })
        }
      }
    } else {
      content = fromFile()
      if (!hashOk) notes.push(`${m.path} was edited after the export; its current text was imported.`)
      revisions = [
        {
          revision: m.revision,
          title: content.title,
          body: content.body,
          status: content.status,
          frontmatter: snapshot(m, decidedOn, content),
          change: 'import',
          actorLabel: updatedByLabel,
          via: 'import',
          clientName: cleanClient(m.client_name),
          importedFrom: {
            via: null,
            actor_label: cleanLine(m.updated_by_label),
            token_id: null,
            client_name: cleanClient(m.client_name),
          },
          createdAt: new Date(m.updated_at),
        },
      ]
    }
    checkState(m, content)
    items.push({
      m,
      content,
      revision,
      decidedOn,
      updatedAt,
      updatedByLabel,
      statusChangedAt,
      revisions,
      appended,
    })
  }

  // edges
  const seenEdgeIds = new Set<string>()
  const seenEdgeKeys = new Set<string>()
  for (const e of manifest.edges) {
    if (seenEdgeIds.has(e.id)) throw invalidArchive('Duplicate edge id in the manifest.')
    seenEdgeIds.add(e.id)
    if (!ids.has(e.src_id))
      throw invalidArchive('An edge starts at an item that is not in the archive.', [
        { path: 'manifest.edges', message: `src ${e.src_id}` },
      ])
    const key = `${e.src_id}|${e.kind}|${e.dst_ref}`
    if (seenEdgeKeys.has(key))
      throw invalidArchive('Duplicate edge in the manifest.', [
        { path: 'manifest.edges', message: key.slice(0, 120) },
      ])
    seenEdgeKeys.add(key)
    if (e.dst_id === e.src_id)
      throw invalidArchive('An edge points at its own source.', [{ path: 'manifest.edges', message: e.id }])
  }

  // audit
  let audit: PlannedAudit[] = []
  if (manifest.history) {
    audit = jsonLines('audit.jsonl', entries.get('audit.jsonl') as Uint8Array, (r, n) => {
      const p = auditLine.safeParse(r)
      if (!p.success) throw invalidArchive('An audit line is invalid.', issuesOf(p.error, `audit.jsonl:${n}`))
      return toPlannedAudit(p.data)
    })
  }
  return { kind: 'lossless', manifest, items, edges: manifest.edges, audit, notes }
}

function toPlannedAudit(l: AuditLine): PlannedAudit {
  const original = {
    via: l.via,
    actor_label: cleanLine(l.actor_label),
    token_id: null as string | null,
    client_name: cleanClient(l.client_name),
  }
  const prior =
    l.via === 'import' && typeof l.data.imported_from === 'object' && l.data.imported_from !== null
      ? l.data.imported_from
      : null
  return {
    at: new Date(l.at),
    actorLabel: importedLabel(l.actor_label),
    clientName: cleanClient(l.client_name),
    action: cleanLine(l.action),
    itemId: l.item_id,
    itemHandle: l.item_handle === null ? null : cleanLine(l.item_handle),
    summary: [...cleanLine(l.summary)].slice(0, 300).join(''),
    data: { ...l.data, imported_from: prior ?? original },
  }
}

// ---- manifest-less archives: a folder of Markdown files -------------------------------------------------

function humanise(slug: string): string {
  const s = slug.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function h1(body: string): string | null {
  let fence = false
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) return m[1] as string
  }
  return null
}

function parseFiles(entries: Map<string, Uint8Array>): FilesArchive {
  const files: FileItem[] = []
  const notes: string[] = []
  for (const name of [...entries.keys()].sort()) {
    if (name.startsWith('revisions/') || name === 'audit.jsonl') {
      throw invalidArchive('Revisions and audit rows need a manifest.json.', [
        { path: shortName(name), message: 'no manifest' },
      ])
    }
    const space = name.split('/')[0] as Space
    const file = name.slice(space.length + 1, -'.md'.length)
    let slug = file
    let adr: number | null = null
    if (space === 'decisions') {
      const m = /^(\d{4,5})-(.+)$/.exec(file) as RegExpExecArray
      adr = Number.parseInt(m[1] as string, 10)
      slug = m[2] as string
    }
    const { fm, body } = readMarkdown(decode(name, entries.get(name) as Uint8Array), name)
    const zodRes = frontmatterSchemas[space].safeParse(fm)
    if (!zodRes.success)
      throw invalidArchive('Frontmatter is invalid.', issuesOf(zodRes.error, shortName(name)))
    const typed = zodRes.data as Record<string, unknown>
    let title = typeof fm.title === 'string' ? fm.title : (h1(body) ?? humanise(slug))
    if (space === 'decisions' && typeof fm.title !== 'string')
      title = title.replace(/^ADR-?\d+\s*[:.-]\s*/i, '').replace(/^\d+\.\s*/, '')
    if (typeof typed.adr === 'number') adr = typed.adr
    const content = contentFrom(space, fm, {
      path: name,
      body,
      titleFallback: title,
      defaultStatus: space === 'decisions' ? 'accepted' : 'active',
    })
    const lv = typeof typed.last_verified === 'string' ? new Date(typed.last_verified) : null
    files.push({
      path: name,
      space,
      slug,
      adr,
      content,
      pinned: typed.pinned === true,
      lastVerified: lv && !Number.isNaN(lv.getTime()) ? lv : null,
      decidedOn: space === 'decisions' && typeof typed.date === 'string' ? typed.date : null,
      spoorId: typeof typed.spoor_id === 'string' ? typed.spoor_id.toLowerCase() : null,
      relations: Array.isArray(typed.relations)
        ? (typed.relations as { kind: string; to: string }[]).map((r) => ({ kind: r.kind, to: r.to }))
        : [],
      supersedes: typeof typed.supersedes === 'string' ? typed.supersedes : null,
      draftedFrom: Array.isArray(typed.drafted_from) ? (typed.drafted_from as string[]) : [],
      clientName: null,
    })
  }
  if (files.length === 0) throw invalidArchive('The archive contains no Markdown files.')
  return { kind: 'files', files, notes }
}

/** Parse the entries of a hardened unzip. */
export function parseArchive(entries: Map<string, Uint8Array>): ParsedArchive {
  return entries.has('manifest.json') ? parseLossless(entries) : parseFiles(entries)
}
