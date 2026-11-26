// The Markdown zip (ADR-0041) without a database: layout, README index, byte-equal files, re-import.

import { serializeMarkdown } from '@spoor/shared'
import { strFromU8, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import { entryAllowed, type LosslessArchive, parseArchive } from './archive.js'
import { sha256Hex } from './canonical.js'
import { exportFrontmatter } from './content.js'
import { cell, markdownZip } from './markdown.js'
import { readZip, writeZip } from './zip.js'

const T = '2026-10-19T12:00:00.000Z'
const NOW = new Date('2026-11-26T09:30:00.000Z')
const PROJECT_ID = '99999999-9999-4999-8999-999999999999'
const uid = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

interface Spec {
  n: number
  space: 'memories' | 'decisions' | 'docs' | 'library'
  slug: string
  title: string
  status?: string
  type?: string
  adr?: number
  lifecycle?: 'active' | 'stale' | 'archived'
  fm?: Record<string, unknown>
}

/** A manifest item and its file, the file built exactly like buildExport builds it. */
function entry(s: Spec, edgeFm: Record<string, unknown> = {}) {
  const id = uid(s.n)
  const status = s.status ?? (s.space === 'decisions' ? 'accepted' : 'active')
  const fm = exportFrontmatter({
    id,
    space: s.space,
    title: s.title,
    tags: ['t'],
    anchors: [],
    pinned: false,
    lastVerifiedAt: new Date(T),
    type: s.space === 'memories' ? (s.type ?? 'fact') : null,
    confidence: s.space === 'memories' ? 'medium' : null,
    status,
    expiresAt: null,
    adrNumber: s.adr ?? null,
    decidedOn: s.space === 'decisions' ? '2026-10-01' : null,
    extras: s.fm ?? {},
    relations: [],
    supersedes: null,
    supersededBy: null,
    draftedFrom: [],
    ...edgeFm,
  })
  const file = serializeMarkdown(fm, `Body of ${s.slug}\n`)
  const path =
    s.space === 'decisions'
      ? `decisions/${String(s.adr).padStart(4, '0')}-${s.slug}.md`
      : `${s.space}/${s.slug}.md`
  const archived = s.lifecycle === 'archived'
  return {
    file,
    m: {
      id,
      space: s.space,
      number: s.n,
      adr_number: s.adr ?? null,
      slug: s.slug,
      path,
      revision: 1,
      content_sha256: sha256Hex(file),
      pinned: false,
      lifecycle: s.lifecycle ?? 'active',
      provenance: 'human',
      last_verified_at: T,
      last_used_at: null,
      expires_at: null,
      stale_since: s.lifecycle === 'stale' ? T : null,
      archived_at: archived ? T : null,
      archive_reason: archived ? 'manual' : null,
      status_changed_at: T,
      decided_on: s.space === 'decisions' ? '2026-10-01' : null,
      source_path: null,
      push_conflict_at: null,
      created_at: T,
      created_by_label: 'ann@example.com',
      updated_at: T,
      updated_by_label: 'ann@example.com',
      client_name: null,
    },
  }
}

function archive(kind: 'project' | 'shared' = 'project'): LosslessArchive {
  const fact = {
    n: 1,
    space: 'memories',
    slug: 'session-store',
    title: 'Session | store',
    type: 'fact',
  } as const
  const proc = { n: 2, space: 'memories', slug: 'deploy', title: 'How to deploy', type: 'procedure' } as const
  const oldAdr = {
    n: 3,
    space: 'decisions',
    slug: 'use-redis',
    title: 'Use Redis',
    adr: 1,
    status: 'superseded',
  } as const
  const newAdr = { n: 4, space: 'decisions', slug: 'use-postgres', title: 'Use Postgres', adr: 2 } as const
  const doc = { n: 5, space: 'docs', slug: 'runbook', title: 'Runbook', lifecycle: 'archived' } as const
  const lib = {
    n: 6,
    space: 'library',
    slug: 'style-guide',
    title: 'Style guide',
    fm: { owner: 'docs-team' },
  } as const
  const stale = {
    n: 7,
    space: 'memories',
    slug: 'old-note',
    title: 'Old note',
    type: 'observation',
    lifecycle: 'stale',
  } as const
  const edges = [
    {
      id: uid(11),
      src_id: uid(4),
      kind: 'supersedes',
      dst_ref: uid(3),
      dst_id: uid(3),
      created_at: T,
      created_by_label: 'ann@example.com',
      client_name: null,
    },
    {
      id: uid(12),
      src_id: uid(1),
      kind: 'supports',
      dst_ref: uid(4),
      dst_id: uid(4),
      created_at: T,
      created_by_label: 'ann@example.com',
      client_name: null,
    },
  ]
  const entries = [
    entry(fact, { relations: [{ kind: 'supports', to: uid(4) }] }),
    entry(proc),
    entry(oldAdr, { supersededBy: 'ADR-0002' }),
    entry(newAdr, { supersedes: uid(3) }),
    entry(doc),
    entry(lib),
    // an observation needs an expiry in a lossless archive; stale memories use a fact here
    entry({ ...stale, type: 'fact' }),
  ]
  const manifest = {
    format: 'spoor-export/1',
    exported_at: '2026-11-26T09:00:00Z',
    spoor_version: '0.8.0',
    history: false,
    project: {
      id: PROJECT_ID,
      kind,
      slug: kind === 'shared' ? '_shared' : 'acme',
      name: 'Acme <Core>',
      description: '',
      settings: {},
      next_item_number: 8,
      next_adr_number: 3,
    },
    items: entries.map((e) => e.m),
    edges,
  }
  const files: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(manifest)) }
  for (const e of entries) files[e.m.path] = strToU8(e.file)
  const parsed = parseArchive(readZip(writeZip(files, new Date(T)), entryAllowed))
  if (parsed.kind !== 'lossless') throw new Error('expected a lossless archive')
  return parsed
}

const unzip = (zip: Uint8Array) => readZip(zip, entryAllowed)

describe('markdownZip', () => {
  it('writes the flat layout with README.md first and the file name of the day', () => {
    const md = markdownZip(archive(), { kind: 'live' }, { now: NOW })
    expect(md.fileName).toBe('spoor-acme-markdown-20261126.zip')
    const entries = unzip(md.zip)
    expect([...entries.keys()]).toEqual([
      'README.md',
      'memories/session-store.md',
      'memories/deploy.md',
      'decisions/0001-use-redis.md',
      'decisions/0002-use-postgres.md',
      'docs/runbook.md',
      'library/style-guide.md',
      'memories/old-note.md',
    ])
    expect(md.counts).toEqual({
      items: 7,
      active: 5,
      inactive: 2,
      bySpace: { memories: 3, decisions: 2, docs: 1, library: 1 },
    })
  })

  it('every item file is byte-equal to the export file (canonical frontmatter, edges included)', () => {
    const a = archive()
    const entries = unzip(markdownZip(a, { kind: 'live' }, { now: NOW }).zip)
    for (const i of a.items) {
      const bytes = entries.get(i.m.path) as Uint8Array
      expect(sha256Hex(bytes), i.m.path).toBe(i.m.content_sha256)
    }
    const adr = strFromU8(entries.get('decisions/0001-use-redis.md') as Uint8Array)
    expect(adr).toContain('superseded_by: ADR-0002')
    expect(strFromU8(entries.get('library/style-guide.md') as Uint8Array)).toContain('owner: docs-team')
  })

  it('the README indexes active items by space and memory type, inactive ones separately', () => {
    const readme = strFromU8(
      unzip(markdownZip(archive(), { kind: 'live' }, { now: NOW }).zip).get('README.md') as Uint8Array,
    )
    expect(readme).toContain('# Acme \\<Core\\>')
    expect(readme).toContain('Markdown export of the Spoor project `acme`.')
    expect(readme).toContain('- Source: the live project')
    expect(readme).toContain('- Exported: 2026-11-26T09:30:00Z')
    expect(readme).toContain('- Items: 7 (5 active, 2 inactive): 3 memories, 2 decisions, 1 docs, 1 library')
    // memories grouped by type, in MEMORY_TYPES order; the stale note is still active
    const facts = readme.indexOf('### Facts')
    const procedures = readme.indexOf('### Procedures')
    expect(facts).toBeGreaterThan(0)
    expect(procedures).toBeGreaterThan(facts)
    expect(readme).toContain(
      '| m1 | Session \\| store | active | [memories/session-store.md](memories/session-store.md) |',
    )
    expect(readme).toContain('| m7 | Old note | active | [memories/old-note.md](memories/old-note.md) |')
    expect(readme).toContain('## Decisions (ADRs)')
    expect(readme).toContain(
      '| ADR-0002 | Use Postgres | accepted | [decisions/0002-use-postgres.md](decisions/0002-use-postgres.md) |',
    )
    expect(readme).toContain('## Library')
    // superseded ADR and archived doc: only in the inactive table
    const inactive = readme.slice(readme.indexOf('## Inactive items'))
    expect(inactive).toContain(
      '| ADR-0001 | decisions | Use Redis | superseded | active | [decisions/0001-use-redis.md]',
    )
    expect(inactive).toContain(
      '| d5 | docs | Runbook | active | archived | [docs/runbook.md](docs/runbook.md) |',
    )
    expect(readme.slice(0, readme.indexOf('## Inactive items'))).not.toContain('Use Redis')
    expect(readme).not.toContain('## Docs')
  })

  it('names the backup as the source, and shared handles carry the shared prefix', () => {
    const md = markdownZip(
      archive('shared'),
      { kind: 'backup', backupId: '20261120T030000Z-auto', backupCreatedAt: '2026-11-20T03:00:00Z' },
      { now: NOW },
    )
    expect(md.fileName).toBe('spoor-_shared-markdown-20261126.zip')
    const readme = strFromU8(unzip(md.zip).get('README.md') as Uint8Array)
    expect(readme).toContain('- Source: backup `20261120T030000Z-auto` (taken 2026-11-20T03:00:00Z)')
    expect(readme).toMatch(/\| S:m1 \|/)
  })

  it('re-imports as a manifest-less archive: the README is skipped, every item comes back', () => {
    const parsed = parseArchive(unzip(markdownZip(archive(), { kind: 'live' }, { now: NOW }).zip))
    expect(parsed.kind).toBe('files')
    if (parsed.kind !== 'files') return
    expect(parsed.files.map((f) => f.path).sort()).toEqual([
      'decisions/0001-use-redis.md',
      'decisions/0002-use-postgres.md',
      'docs/runbook.md',
      'library/style-guide.md',
      'memories/deploy.md',
      'memories/old-note.md',
      'memories/session-store.md',
    ])
    const adr = parsed.files.find((f) => f.slug === 'use-postgres')
    expect(adr).toMatchObject({ space: 'decisions', adr: 2, supersedes: uid(3), spoorId: uid(4) })
    expect(adr?.content.title).toBe('Use Postgres')
    const fact = parsed.files.find((f) => f.slug === 'session-store')
    expect(fact?.relations).toEqual([{ kind: 'supports', to: uid(4) }])
    expect(fact?.content).toMatchObject({ title: 'Session | store', type: 'fact', status: 'active' })
  })

  it('refuses a manifest-less archive (it has no numbers, lifecycle or edges)', () => {
    const files = parseArchive(unzip(markdownZip(archive(), { kind: 'live' }, { now: NOW }).zip))
    expect(() => markdownZip(files, { kind: 'live' })).toThrow(ApiError)
  })

  it('escapes table cells', () => {
    expect(cell('a|b')).toBe('a\\|b')
    expect(cell('x\ny')).toBe('x y')
    expect(cell('[link](u) *b* <i>')).toBe('\\[link\\](u) \\*b\\* \\<i\\>')
  })
})

describe('README.md in an import', () => {
  it('a lossless archive with a root README.md imports; the README is ignored', () => {
    const md = markdownZip(archive(), { kind: 'live' }, { now: NOW })
    const entries = unzip(md.zip)
    // put a manifest next to it: the export plus README, as a person might zip it
    const a = archive()
    const files: Record<string, Uint8Array> = { 'README.md': entries.get('README.md') as Uint8Array }
    for (const i of a.items) files[i.m.path] = entries.get(i.m.path) as Uint8Array
    files['manifest.json'] = strToU8(
      JSON.stringify({ ...a.manifest, items: a.manifest.items, edges: a.manifest.edges }),
    )
    const parsed = parseArchive(unzip(writeZip(files, new Date(T))))
    expect(parsed.kind).toBe('lossless')
  })

  it('only a README.md is not an archive of Markdown files', () => {
    const zip = writeZip({ 'README.md': strToU8('# hi\n') }, new Date(T))
    expect(() => parseArchive(unzip(zip))).toThrow(/no Markdown files/)
  })

  it('a README.md below the root is still refused by the allowlist', () => {
    const zip = writeZip({ 'docs/README.md': strToU8('# hi\n') }, new Date(T))
    expect(() => unzip(zip)).toThrow(ApiError)
  })
})
