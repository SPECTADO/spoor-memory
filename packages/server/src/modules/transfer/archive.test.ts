// Parsing and validating archives without a database (data-model.md section 8).

import { serializeMarkdown as renderMarkdown } from '@spoor/shared'
import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import { entryAllowed, importedLabel, parseArchive } from './archive.js'
import { sha256Hex } from './canonical.js'
import { readZip, writeZip } from './zip.js'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const T = '2026-10-19T12:00:00.000Z'

function item(over: Record<string, unknown> = {}, text?: string) {
  const fm = {
    spoor_id: ID,
    title: 'Session store',
    tags: ['auth'],
    anchors: [],
    pinned: false,
    last_verified: T,
    relations: [],
    type: 'fact',
    confidence: 'medium',
    status: 'active',
  }
  const file = text ?? renderMarkdown(fm, 'Body text\n')
  const m = {
    id: ID,
    space: 'memories',
    number: 1,
    adr_number: null,
    slug: 'session-store',
    path: 'memories/session-store.md',
    revision: 2,
    content_sha256: sha256Hex(file),
    pinned: false,
    lifecycle: 'active',
    provenance: 'agent',
    last_verified_at: T,
    last_used_at: null,
    expires_at: null,
    stale_since: null,
    archived_at: null,
    archive_reason: null,
    status_changed_at: T,
    decided_on: null,
    source_path: null,
    push_conflict_at: null,
    created_at: T,
    created_by_label: 'ann@example.com',
    updated_at: T,
    updated_by_label: 'bob@example.com',
    client_name: 'claude-code/2.1',
    ...over,
  }
  return { m, file }
}
const rev = (n: number, over: Record<string, unknown> = {}) => ({
  revision: n,
  title: 'Session store',
  body: n === 1 ? 'Old body\n' : 'Body text\n',
  status: 'active',
  frontmatter: {
    spoor_id: ID,
    title: 'Session store',
    tags: ['auth'],
    anchors: [],
    type: 'fact',
    confidence: 'medium',
  },
  change: n === 1 ? 'create' : 'update',
  actor_label: 'ann@example.com',
  via: 'mcp',
  client_name: 'claude-code/2.1',
  imported_from: null,
  created_at: T,
  ...over,
})

function build(
  opts: {
    history?: boolean
    edges?: unknown[]
    mutate?: (files: Record<string, Uint8Array>, manifest: Record<string, unknown>) => void
    it?: ReturnType<typeof item>
  } = {},
) {
  const history = opts.history ?? true
  const { m, file } = opts.it ?? item()
  const manifest: Record<string, unknown> = {
    format: 'spoor-export/1',
    exported_at: '2026-10-19T12:00:00Z',
    spoor_version: '0.1.0',
    history,
    project: {
      id: ID2,
      kind: 'project',
      slug: 'acme',
      name: 'Acme',
      description: '',
      settings: {},
      next_item_number: 5,
      next_adr_number: 1,
    },
    items: [m],
    edges: opts.edges ?? [],
  }
  const files: Record<string, Uint8Array> = { [m.path as string]: strToU8(file) }
  if (history) {
    files[`revisions/${m.id}.jsonl`] = strToU8(`${JSON.stringify(rev(1))}\n${JSON.stringify(rev(2))}\n`)
    files['audit.jsonl'] = strToU8(
      `${JSON.stringify({ at: T, actor_label: 'ann@example.com', via: 'mcp', client_name: null, action: 'item.create', item_id: ID, item_handle: 'm1', summary: 'ann created m1', data: {} })}\n`,
    )
  }
  opts.mutate?.(files, manifest)
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  // through the real zip path so names are checked as an import would
  return readZip(writeZip(files, new Date(T)), entryAllowed)
}

const firstItem = (mf: Record<string, unknown>) =>
  (mf.items as Record<string, unknown>[])[0] as Record<string, unknown>

const issue = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError) return `${e.code}: ${e.message}`
    throw e
  }
}

describe('parseArchive (manifest)', () => {
  it('parses a valid archive with history and marks provenance', () => {
    const a = parseArchive(build())
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    expect(a.items).toHaveLength(1)
    const pi = a.items[0]
    expect(pi?.revision).toBe(2)
    expect(pi?.appended).toBe(false)
    expect(pi?.content).toMatchObject({
      title: 'Session store',
      body: 'Body text\n',
      type: 'fact',
      tags: ['auth'],
    })
    expect(pi?.revisions.map((r) => r.revision)).toEqual([1, 2])
    for (const r of pi?.revisions ?? []) {
      expect(r.via).toBe('import')
      expect(r.actorLabel).toBe('imported: ann@example.com')
      expect(r.importedFrom).toEqual({
        via: 'mcp',
        actor_label: 'ann@example.com',
        token_id: null,
        client_name: 'claude-code/2.1',
      })
    }
    expect(pi?.updatedByLabel).toBe('imported: bob@example.com')
    expect(a.audit[0]).toMatchObject({
      actorLabel: 'imported: ann@example.com',
      data: { imported_from: { via: 'mcp', actor_label: 'ann@example.com' } },
    })
  })

  it('keeps an existing imported_from and does not stack prefixes', () => {
    expect(importedLabel('imported: ann')).toBe('imported: ann')
    expect(importedLabel('a‮b')).toBe('imported: ab')
    const original = { via: 'mcp', actor_label: 'ann', token_id: null, client_name: null }
    const a = parseArchive(
      build({
        mutate: (files) => {
          const id = ID
          files[`revisions/${id}.jsonl`] = strToU8(
            `${JSON.stringify(rev(1, { via: 'import', actor_label: 'imported: ann', imported_from: original }))}\n${JSON.stringify(rev(2, { via: 'import', actor_label: 'imported: ann', imported_from: original }))}\n`,
          )
        },
      }),
    )
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    expect(a.items[0]?.revisions[0]).toMatchObject({ actorLabel: 'imported: ann', importedFrom: original })
  })

  it('appends one revision when the Markdown file was edited after the export', () => {
    const edited = renderMarkdown(
      {
        spoor_id: ID,
        title: 'Session store v2',
        tags: ['auth'],
        anchors: [],
        pinned: false,
        relations: [],
        type: 'fact',
        confidence: 'high',
        status: 'active',
      },
      'New body\n',
    )
    const base = item()
    const a = parseArchive(
      build({
        it: { m: base.m, file: edited } /* manifest keeps the OLD hash */,
        mutate: (_f, mf) => {
          firstItem(mf).content_sha256 = base.m.content_sha256
        },
      }),
    )
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    const pi = a.items[0]
    expect(pi?.appended).toBe(true)
    expect(pi?.revision).toBe(3)
    expect(pi?.content).toMatchObject({ title: 'Session store v2', body: 'New body\n', confidence: 'high' })
    expect(pi?.revisions.at(-1)).toMatchObject({ revision: 3, change: 'import', via: 'import' })
  })

  it('does not append a revision when only operational state changed in the file', () => {
    const edited = renderMarkdown(
      {
        spoor_id: ID,
        title: 'Session store',
        tags: ['auth'],
        anchors: [],
        pinned: true,
        last_verified: '2027-01-01T00:00:00Z',
        relations: [],
        type: 'fact',
        confidence: 'medium',
        status: 'active',
      },
      'Body text\n',
    )
    const base = item()
    const a = parseArchive(
      build({
        it: { m: base.m, file: edited },
        mutate: (_f, mf) => {
          firstItem(mf).content_sha256 = base.m.content_sha256
        },
      }),
    )
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    expect(a.items[0]?.appended).toBe(false)
    expect(a.items[0]?.revision).toBe(2)
  })

  it('synthesises one revision per item at the item revision when history is false', () => {
    const a = parseArchive(build({ history: false }))
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    const pi = a.items[0]
    expect(pi?.revisions).toHaveLength(1)
    expect(pi?.revisions[0]).toMatchObject({
      revision: 2,
      change: 'import',
      via: 'import',
      actorLabel: 'imported: bob@example.com',
    })
    expect(pi?.revisions[0]?.frontmatter).toMatchObject({
      spoor_id: ID,
      title: 'Session store',
      type: 'fact',
    })
    expect(a.audit).toEqual([])
  })

  it('rejects broken archives', () => {
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (_f, mf) => {
              mf.format = 'other'
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              delete f[`revisions/${ID}.jsonl`]
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              f['docs/extra.md'] = strToU8('# x')
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              f[`revisions/${ID2}.jsonl`] = strToU8('')
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              f[`revisions/${ID}.jsonl`] = strToU8(`${JSON.stringify(rev(1))}\n`)
            },
          }),
        ),
      ),
    ).toMatch(/last revision/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              f[`revisions/${ID}.jsonl`] = strToU8(`${JSON.stringify(rev(2))}\n${JSON.stringify(rev(1))}\n`)
            },
          }),
        ),
      ),
    ).toMatch(/ascending/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (f) => {
              f[`revisions/${ID}.jsonl`] = strToU8('{not json}\n')
            },
          }),
        ),
      ),
    ).toMatch(/JSON/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (_f, mf) => {
              firstItem(mf).path = 'docs/session-store.md'
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (_f, mf) => {
              firstItem(mf).number = 0
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (_f, mf) => {
              mf.unexpected = 1
            },
          }),
        ),
      ),
    ).toMatch(/^invalid_archive/)
    expect(
      issue(() =>
        parseArchive(
          build({
            history: false,
            mutate: (f) => {
              f['audit.jsonl'] = strToU8('')
            },
          }),
        ),
      ),
    ).toMatch(/history is false/)
    // an observation must carry an expiry
    expect(
      issue(() =>
        parseArchive(
          build({
            mutate: (_f, mf) => {
              firstItem(mf).expires_at = T
            },
          }),
        ),
      ),
    ).toMatch(/expires_at/)
  })

  it('rejects edges whose source is not in the archive, duplicates and self loops', () => {
    const e = (over: Record<string, unknown> = {}) => ({
      id: '33333333-3333-4333-8333-333333333333',
      src_id: ID,
      kind: 'wikilink',
      dst_ref: 'x',
      dst_id: null,
      created_at: T,
      created_by_label: null,
      client_name: null,
      ...over,
    })
    expect(issue(() => parseArchive(build({ edges: [e()] })))).toBe('ok')
    expect(issue(() => parseArchive(build({ edges: [e({ src_id: ID2 })] })))).toMatch(/^invalid_archive/)
    expect(
      issue(() => parseArchive(build({ edges: [e(), e({ id: '44444444-4444-4444-8444-444444444444' })] }))),
    ).toMatch(/^invalid_archive/)
    expect(issue(() => parseArchive(build({ edges: [e({ dst_id: ID })] })))).toMatch(/own source/)
  })
})

describe('parseArchive (folder of Markdown files)', () => {
  const zip = (files: Record<string, string>) =>
    readZip(
      writeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), new Date(T)),
      entryAllowed,
    )

  it('reads files without a manifest: titles, ADR numbers from names, relations', () => {
    const a = parseArchive(
      zip({
        'memories/cache-ttl.md':
          '---\ntype: fact\ntitle: Cache TTL\nrelations:\n  - kind: supports\n    to: use-redis\n---\nBody [[use-redis]]',
        'decisions/0007-use-redis.md': '# ADR-0007: Use Redis\n\nWe use it.',
        'docs/runbook.md': 'no frontmatter at all',
      }),
    )
    if (a.kind !== 'files') throw new Error('expected files')
    const by = Object.fromEntries(a.files.map((f) => [f.path, f]))
    expect(by['memories/cache-ttl.md']).toMatchObject({
      space: 'memories',
      slug: 'cache-ttl',
      content: { title: 'Cache TTL', type: 'fact' },
      relations: [{ kind: 'supports', to: 'use-redis' }],
    })
    expect(by['decisions/0007-use-redis.md']).toMatchObject({
      adr: 7,
      slug: 'use-redis',
      content: { title: 'Use Redis', status: 'accepted' },
    })
    expect(by['docs/runbook.md']?.content.title).toBe('Runbook')
  })

  it('rejects a memory without a type, an empty archive, and revisions without a manifest', () => {
    expect(issue(() => parseArchive(zip({ 'memories/a.md': '---\ntitle: A\n---\nx' })))).toMatch(
      /^invalid_archive/,
    )
    expect(issue(() => parseArchive(zip({ 'audit.jsonl': '' })))).toMatch(/manifest/)
  })
})

describe('lifecycle invariants of a manifest item (phase-2 review)', () => {
  it('a pinned item cannot be stale', () => {
    const it = item({ pinned: true, lifecycle: 'stale', stale_since: T })
    expect(issue(() => parseArchive(build({ it })))).toMatch(/^invalid_archive/)
  })
  it('an archive edit of only a decision date appends a revision (date is content)', () => {
    const fm = (date: string) => ({
      spoor_id: ID,
      title: 'Use Postgres',
      tags: [],
      anchors: [],
      pinned: false,
      relations: [],
      adr: 7,
      status: 'accepted',
      date,
    })
    const original = renderMarkdown(fm('2026-01-01'), 'Body text\n')
    const base = item(
      {
        space: 'decisions',
        number: 1,
        adr_number: 7,
        slug: 'use-postgres',
        path: 'decisions/0007-use-postgres.md',
        decided_on: '2026-01-01',
      },
      original,
    )
    const r = (n: number) =>
      rev(n, {
        title: 'Use Postgres',
        status: 'accepted',
        frontmatter: {
          spoor_id: ID,
          title: 'Use Postgres',
          tags: [],
          anchors: [],
          adr: 7,
          status: 'accepted',
          date: '2026-01-01',
        },
      })
    const a = parseArchive(
      build({
        it: { m: base.m, file: renderMarkdown(fm('2026-02-02'), 'Body text\n') },
        mutate: (f, mf) => {
          firstItem(mf).content_sha256 = base.m.content_sha256
          f[`revisions/${ID}.jsonl`] = strToU8(`${JSON.stringify(r(1))}\n${JSON.stringify(r(2))}\n`)
        },
      }),
    )
    if (a.kind !== 'lossless') throw new Error('expected lossless')
    expect(a.items[0]?.appended).toBe(true)
    expect(a.items[0]?.decidedOn).toBe('2026-02-02')
    expect(a.items[0]?.revisions.at(-1)?.frontmatter).toMatchObject({
      status: 'accepted',
      date: '2026-02-02',
    })
  })
})
