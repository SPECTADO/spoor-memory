import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from './fsutil.js'
import { acquireImportLock, isImportLock, readImportQueue } from './import-queue.js'
import { readState } from './state.js'
import {
  bodyOf,
  deadUrl,
  type FakeServer,
  fakeServer,
  localEnv,
  makeRepo,
  type Req,
  run,
  uuid,
  writeFile,
} from './testing/harness.js'

let srv: FakeServer
beforeEach(async () => {
  srv = await fakeServer()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await srv.close()
})

const IMPORT = 'POST /p/acme/api/adr/import'
const PUSH = 'POST /p/acme/api/push'

const ids = new Map<string, string>()
const idFor = (p: string) => {
  let v = ids.get(p)
  if (!v) {
    v = uuid()
    ids.set(p, v)
  }
  return v
}

const res = (over: Record<string, unknown>) => ({
  status: 'created',
  handle: 'ADR-0001',
  spoor_id: uuid(),
  space: 'decisions',
  revision: 1,
  number: 1,
  adr_number: 1,
  renumbered: null,
  warnings: [],
  ...over,
})

type SentFile = { source_path: string; content: string }
const filesOf = (q: Req) => (q.body as { files: SentFile[] }).files
const pathsOf = (q: Req) => filesOf(q).map((f) => f.source_path)

/** An import answer: one success per sent file, `over(path)` replaces fields (or the whole result). */
const answer = (q: Req, over: (path: string) => Record<string, unknown> | undefined = () => ({})) => ({
  body: {
    results: pathsOf(q).map((p) => {
      const o = over(p)
      if (o && 'error' in o) return { source_path: p, ...o }
      return res({ source_path: p, spoor_id: idFor(p), ...o })
    }),
  },
})

const imports = () => srv.requests.filter((q) => `${q.method} ${q.path}` === IMPORT)

function adrRepo(n: number, content = (i: number) => `# A ${i}\n`) {
  const files: Record<string, string> = {}
  for (let i = 1; i <= n; i++) files[`docs/adr/${String(i).padStart(4, '0')}-a.md`] = content(i)
  return makeRepo({ local: localEnv(srv.url), files })
}

function recorder() {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) }
}

const queueFile = (repo: string) => join(repo, '.spoor', 'import-queue.json')
const lockFile = (repo: string) => join(repo, '.spoor', 'import.lock')

describe('adr import: batches and headers', () => {
  it('sends 10, 10 and 5 files with the same reserve_above and both headers; a clean run is quiet on stderr', async () => {
    const repo = adrRepo(25)
    srv.on(IMPORT, (q) => answer(q))
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(imports().map((q) => filesOf(q).length)).toEqual([10, 10, 5])
    for (const q of imports()) {
      expect((q.body as { reserve_above: number }).reserve_above).toBe(25)
      expect(q.headers['spoor-defer-embedding']).toBe('1')
      expect(q.headers['spoor-import-edges']).toBe('defer')
    }
    expect(r.out).toContain('25 created, 0 updated, 0 unchanged, 0 renumbered, 0 errors')
    expect(existsSync(queueFile(repo))).toBe(false)
    expect(existsSync(lockFile(repo))).toBe(false)
  })

  it('60 KiB files go two per request', async () => {
    const repo = adrRepo(4, (i) => `# A ${i}\n${'x'.repeat(60 * 1024)}\n`)
    srv.on(IMPORT, (q) => answer(q))
    expect((await run(['adr', 'import'], { cwd: repo })).code).toBe(0)
    expect(imports().map((q) => filesOf(q).length)).toEqual([2, 2])
  })

  it('--dry-run prints the plan and sends nothing', async () => {
    const repo = adrRepo(25)
    const dry = await run(['adr', 'import', '--dry-run'], { cwd: repo })
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('would import docs/adr/0001-a.md\n')
    expect(dry.out).toContain('25 files in 3 request(s), reserve_above 25\n')
    expect(srv.requests).toHaveLength(0)
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('writes spoor_id back, renames a renumbered ADR and moves it on the server through pass 2 (no /api/push)', async () => {
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: {
        'docs/adr/0001-first.md': '---\n# keep me\nstatus: accepted\n---\n# First\n\nbody\n',
        'docs/adr/0002-second.md': '---\nadr: 2\n---\n# ADR-0002: Second\n',
        'docs/adr/0003-third.md': '# Third\n',
        'docs/adr/README.md': '# index\n',
        'docs/adr/template.md': '# t\n',
        'docs/adr/notes.txt': 'x',
      },
    })
    const id1 = uuid()
    const id2 = uuid()
    srv.on(IMPORT, (q) => {
      if (q.headers['spoor-import-edges'] === 'defer')
        return {
          body: {
            results: [
              res({ source_path: 'docs/adr/0001-first.md', spoor_id: id1 }),
              res({
                source_path: 'docs/adr/0002-second.md',
                spoor_id: id2,
                handle: 'ADR-0004',
                renumbered: { from: 2, to: 4 },
                warnings: [{ code: 'ambiguous_ref', ref: 'ADR-0002', candidates: [] }],
              }),
              { source_path: 'docs/adr/0003-third.md', error: 'invalid_input', message: 'bad' },
            ],
          },
        }
      return {
        body: {
          results: [
            res({
              source_path: 'docs/adr/0004-second.md',
              spoor_id: id2,
              handle: 'ADR-0004',
              status: 'updated',
              revision: 2,
            }),
          ],
        },
      }
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(r.out).toContain('skipped docs/adr/README.md')
    expect(r.out).toContain('skipped docs/adr/notes.txt')
    expect(r.out).toContain('renumbered docs/adr/0002-second.md → docs/adr/0004-second.md (ADR 2 → 4)')
    expect(r.out).toContain('rewrote the H1 of docs/adr/0002-second.md (ADR 2 → 4)')
    expect(r.out).toContain('ambiguous reference ADR-0002')
    expect(r.out).toContain('error docs/adr/0003-third.md: invalid_input (bad)')
    expect(r.out).toContain('2 created, 0 updated, 0 unchanged, 1 renumbered, 1 errors')
    expect(readFileSync(join(repo, 'docs/adr/0001-first.md'), 'utf8')).toBe(
      `---\nspoor_id: ${id1}\n# keep me\nstatus: accepted\n---\n# First\n\nbody\n`,
    )
    expect(readFileSync(join(repo, 'docs/adr/0004-second.md'), 'utf8')).toBe(
      `---\nspoor_id: ${id2}\nadr: 4\n---\n# ADR-0004: Second\n`,
    )
    expect(existsSync(join(repo, 'docs/adr/0002-second.md'))).toBe(false)
    expect(readFileSync(join(repo, 'docs/adr/0003-third.md'), 'utf8')).toBe('# Third\n')
    expect(srv.count(PUSH)).toBe(0)
    expect(imports().map(pathsOf)).toEqual([
      ['docs/adr/0001-first.md', 'docs/adr/0002-second.md', 'docs/adr/0003-third.md'],
      ['docs/adr/0004-second.md'],
    ])
    expect(imports()[1]?.headers['spoor-import-edges']).toBeUndefined()
    expect(bodyOf<{ reserve_above: number }>(imports()[1]).reserve_above).toBe(3)
    expect(readState(repo).bases[id2]).toMatchObject({ path: 'docs/adr/0004-second.md', revision: 2 })
    // the failed file stays in the queue for the next run
    expect(readImportQueue(repo).adr?.entries['docs/adr/0003-third.md']).toMatchObject({
      status: 'failed',
      error: 'invalid_input',
    })
  })
})

describe('adr import: resume', () => {
  it('stops after five 500s with the counts, then resumes only the rest; --all sends everything', async () => {
    const repo = adrRepo(25)
    let calls = 0
    srv.on(IMPORT, (q) => (++calls === 1 ? answer(q) : { status: 500, body: { error: 'internal' } }))
    const r1 = await run(['adr', 'import'], { cwd: repo })
    expect(r1.code).toBe(3)
    expect(calls).toBe(6)
    expect(r1.err).toContain(
      `spoor: server unreachable (500 ${srv.url}); import stopped. 10 of 25 files imported, 15 remaining. Run the same command again to resume.\n`,
    )
    expect(r1.err).not.toContain('next session')
    const entries = readImportQueue(repo).adr?.entries ?? {}
    expect(Object.values(entries).filter((e) => e.status === 'done')).toHaveLength(10)
    expect(Object.values(entries).filter((e) => e.status === 'pending')).toHaveLength(15)
    expect(existsSync(lockFile(repo))).toBe(false)

    srv.requests.length = 0
    srv.on(IMPORT, (q) => answer(q))
    const r2 = await run(['adr', 'import'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(r2.err).toBe('')
    const sent = imports().flatMap(pathsOf)
    expect(sent).toHaveLength(15)
    expect(sent[0]).toBe('docs/adr/0011-a.md')
    expect(r2.out).toContain('10 already imported and unchanged, not sent (--all sends them again)')
    expect(existsSync(queueFile(repo))).toBe(false)

    srv.requests.length = 0
    const r3 = await run(['adr', 'import'], { cwd: repo })
    expect(r3.code).toBe(0)
    expect(imports()).toHaveLength(0)
    expect(r3.out).toContain('25 already imported and unchanged, not sent (--all sends them again)\n')

    const all = await run(['adr', 'import', '--all'], { cwd: repo })
    expect(all.code).toBe(0)
    expect(imports().flatMap(pathsOf)).toHaveLength(25)
  })

  it('500, 500, then 200: three requests with backoff of 1-2 s and 2-4 s', async () => {
    const repo = adrRepo(1)
    let calls = 0
    srv.on(IMPORT, (q) => (++calls <= 2 ? { status: 500, body: { error: 'internal' } } : answer(q)))
    const rec = recorder()
    const r = await run(['adr', 'import'], { cwd: repo, sleep: rec.sleep })
    expect(r.code).toBe(0)
    expect(calls).toBe(3)
    expect(rec.sleeps.some((ms) => ms >= 1000 && ms <= 2000)).toBe(true)
    expect(rec.sleeps.some((ms) => ms > 2000 && ms <= 4000)).toBe(true)
    expect(r.err).toContain('spoor: server error (500); waiting')
    expect(r.err).toContain('(2 of 5)')
  })

  it('503 busy with Retry-After 7 waits at least 7 s and sends the same files again', async () => {
    const repo = adrRepo(3)
    let calls = 0
    srv.on(IMPORT, (q) =>
      ++calls === 1
        ? {
            status: 503,
            headers: { 'retry-after': '7' },
            body: { error: 'busy', message: 'Too many pushes' },
          }
        : answer(q),
    )
    const rec = recorder()
    const r = await run(['adr', 'import'], { cwd: repo, sleep: rec.sleep })
    expect(r.code).toBe(0)
    expect(Math.max(...rec.sleeps)).toBeGreaterThanOrEqual(7000)
    expect(imports().map(pathsOf)[1]).toEqual(imports().map(pathsOf)[0])
    expect(imports().map((q) => filesOf(q).length)).toEqual([3, 3])
    expect(r.err).toContain('spoor: server busy (503); waiting 7 s')
    expect(existsSync(join(repo, '.spoor', 'offline-until'))).toBe(false)
  })

  it('a timeout waits for the cool-down, then re-sends a halved batch', async () => {
    const repo = adrRepo(10)
    let calls = 0
    srv.on(IMPORT, (q) => (++calls === 1 ? 'hang' : answer(q)))
    const rec = recorder()
    const r = await run(['adr', 'import'], {
      cwd: repo,
      sleep: rec.sleep,
      env: { SPOOR_IMPORT_TIMEOUT_MS: '200' },
    })
    expect(r.code).toBe(0)
    expect(Math.max(...rec.sleeps)).toBeGreaterThanOrEqual(15_000)
    expect(imports().map((q) => filesOf(q).length)).toEqual([10, 5, 5])
    expect(r.err).toContain('spoor: request timed out (timeout); waiting')
    expect(r.out).toContain('10 created')
  })

  it('a server that always answers 503 gets exactly 5 requests and a resume hint', async () => {
    const repo = adrRepo(1)
    srv.on(IMPORT, { status: 503, body: {} })
    const rec = recorder()
    const r = await run(['adr', 'import'], { cwd: repo, sleep: rec.sleep })
    expect(r.code).toBe(3)
    expect(imports()).toHaveLength(5)
    expect(rec.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(300_000)
    expect(r.err).toContain('Run the same command again to resume.')
    expect(r.out + r.err).not.toContain('next session')
  })
})

describe('adr import: fail fast', () => {
  it('connection refused: one attempt, exit 3, the unreachable notice', async () => {
    const repo = makeRepo({ local: localEnv(await deadUrl()), files: { 'docs/adr/0001-a.md': '# A\n' } })
    const rec = recorder()
    const r = await run(['adr', 'import'], { cwd: repo, sleep: rec.sleep })
    expect(r.code).toBe(3)
    expect(r.err).toMatch(/^spoor: server unreachable \(ECONNREFUSED http:\/\/127\.0\.0\.1:\d+\)/)
    expect(r.err).toContain('0 of 1 files imported, 1 remaining. Run the same command again to resume.')
    expect(rec.sleeps).toEqual([])
  })

  it('not configured exits 1', async () => {
    const bare = makeRepo({ files: { 'docs/adr/0001-a.md': '# A\n' } })
    const r = await run(['adr', 'import'], { cwd: bare })
    expect(r.code).toBe(1)
    expect(r.err).toBe(
      'spoor: not configured for this repo (missing SPOOR_URL, SPOOR_PROJECT, SPOOR_TOKEN). Run: spoor login\n',
    )
  })

  it('401 stops with the login notice, no retry', async () => {
    const repo = adrRepo(3)
    srv.on(IMPORT, { status: 401, body: { error: 'invalid_token' } })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(3)
    expect(imports()).toHaveLength(1)
    expect(r.err).toContain(`spoor: token rejected by ${srv.url} (401). Run: spoor login\n`)
    expect(r.err).toContain('spoor: import stopped. 0 of 3 files imported, 3 remaining.')
  })

  it('403 on a batch stops after one request', async () => {
    const repo = adrRepo(3)
    srv.on(IMPORT, { status: 403, body: { error: 'forbidden', message: 'viewer token' } })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(3)
    expect(imports()).toHaveLength(1)
    expect(r.err).toContain('spoor: forbidden: viewer token\nspoor: import stopped.')
    expect(existsSync(lockFile(repo))).toBe(false)
  })
})

describe('adr import: per-file results', () => {
  const internal = { error: 'internal', message: 'Internal error.' }

  it('a file answered internal once is sent again and succeeds', async () => {
    const repo = adrRepo(3)
    let failed = false
    srv.on(IMPORT, (q) =>
      answer(q, (p) => {
        if (failed || !p.endsWith('0002-a.md')) return {}
        failed = true
        return internal
      }),
    )
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([
      ['docs/adr/0001-a.md', 'docs/adr/0002-a.md', 'docs/adr/0003-a.md'],
      ['docs/adr/0002-a.md'],
    ])
    expect(r.out).toContain('3 created, 0 updated, 0 unchanged, 0 renumbered, 0 errors')
  })

  it('internal three times: the file fails, the others are imported', async () => {
    const repo = adrRepo(3)
    srv.on(IMPORT, (q) => answer(q, (p) => (p.endsWith('0002-a.md') ? internal : {})))
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(imports()).toHaveLength(3)
    expect(r.out).toContain('error docs/adr/0002-a.md: internal (Internal error.)')
    expect(r.out).toContain('2 created, 0 updated, 0 unchanged, 0 renumbered, 1 errors')
    expect(readImportQueue(repo).adr?.entries['docs/adr/0002-a.md']?.status).toBe('failed')
  })

  it('"not processed" does not use up an attempt', async () => {
    const repo = adrRepo(2)
    let n = 0
    srv.on(IMPORT, (q) =>
      answer(q, (p) =>
        p.endsWith('0002-a.md') && ++n <= 3 ? { error: 'internal', message: 'not processed' } : {},
      ),
    )
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(imports()).toHaveLength(4)
  })

  it('a batch-level 400 is followed by single-file requests; only the bad file is an error', async () => {
    const repo = adrRepo(3)
    srv.on(IMPORT, (q) => {
      const paths = pathsOf(q)
      if (paths.length > 1 || paths[0]?.endsWith('0002-a.md'))
        return { status: 400, body: { error: 'invalid_input', message: 'files.1.content: too big' } }
      return answer(q)
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(imports().map((q) => filesOf(q).length)).toEqual([3, 1, 1, 1])
    expect(r.out).toContain('error docs/adr/0002-a.md: invalid_input (files.1.content: too big)')
    expect(r.out).toContain('2 created, 0 updated, 0 unchanged, 0 renumbered, 1 errors')
  })

  it('files over the server limits are reported and never sent', async () => {
    const long = `docs/adr/0003-${'a'.repeat(240)}.md`
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: {
        'docs/adr/0001-a.md': '# A\n',
        'docs/adr/0002-big.md': `# Big\n${'x'.repeat(400_001)}`,
        [long]: '# Long\n',
      },
    })
    srv.on(IMPORT, (q) => answer(q))
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(imports().flatMap(pathsOf)).toEqual(['docs/adr/0001-a.md'])
    expect(r.out).toContain('error docs/adr/0002-big.md: too_large')
    expect(r.out).toContain(`error ${long}: invalid_path`)
  })

  it('a file edited during the request is sent again with the new content', async () => {
    const repo = adrRepo(2)
    let calls = 0
    srv.on(IMPORT, (q) => {
      if (++calls === 1) writeFile(repo, 'docs/adr/0001-a.md', '# A 1 edited\n')
      return answer(q)
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([
      ['docs/adr/0001-a.md', 'docs/adr/0002-a.md'],
      ['docs/adr/0001-a.md'],
    ])
    expect(filesOf(imports()[1] as Req)[0]?.content).toContain('# A 1 edited')
    const text = readFileSync(join(repo, 'docs/adr/0001-a.md'), 'utf8')
    expect(readState(repo).bases[idFor('docs/adr/0001-a.md')]?.sha256).toBe(sha256(text))
  })
})

describe('adr import: two passes', () => {
  it('edges_deferred and renumbered files go to one pass-2 request without the edges header', async () => {
    const repo = adrRepo(2)
    const a = 'docs/adr/0001-a.md'
    const b = 'docs/adr/0002-a.md'
    srv.on(IMPORT, (q) => {
      if (q.headers['spoor-import-edges'] === 'defer')
        return answer(q, (p) =>
          p === a
            ? { warnings: [{ code: 'edges_deferred' }, { code: 'embedding_pending' }] }
            : { handle: 'ADR-0003', renumbered: { from: 2, to: 3 }, adr_number: 3 },
        )
      return answer(q, (p) => ({
        status: 'updated',
        revision: 2,
        ...(p === a ? {} : { handle: 'ADR-0003', spoor_id: idFor(b) }),
      }))
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(imports()).toHaveLength(2)
    expect(pathsOf(imports()[1] as Req)).toEqual([a, 'docs/adr/0003-a.md'])
    expect(imports()[1]?.headers['spoor-import-edges']).toBeUndefined()
    expect(imports()[1]?.headers['spoor-defer-embedding']).toBe('1')
    expect(srv.count(PUSH)).toBe(0)
    expect(readState(repo).bases[idFor(b)]).toMatchObject({ path: 'docs/adr/0003-a.md', revision: 2 })
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('old server: an unresolved supersedes sends the file once more and warns once', async () => {
    const repo = adrRepo(1)
    srv.on(IMPORT, (q) =>
      answer(q, () => ({ warnings: [{ code: 'unresolved_supersedes', ref: 'ADR-0009' }] })),
    )
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(imports()).toHaveLength(2)
    expect(r.out.split('unresolved supersedes ADR-0009')).toHaveLength(2)
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('a run stopped in pass 2 leaves status edges; the next run sends only those, without the edges header', async () => {
    const repo = adrRepo(2)
    const a = 'docs/adr/0001-a.md'
    srv.on(IMPORT, (q) =>
      q.headers['spoor-import-edges'] === 'defer'
        ? answer(q, (p) => (p === a ? { warnings: [{ code: 'edges_deferred' }] } : {}))
        : { status: 403, body: { error: 'forbidden', message: 'no' } },
    )
    const r1 = await run(['adr', 'import'], { cwd: repo })
    expect(r1.code).toBe(3)
    expect(readImportQueue(repo).adr?.entries[a]?.status).toBe('edges')
    srv.requests.length = 0
    srv.on(IMPORT, (q) => answer(q, () => ({ status: 'unchanged' })))
    const r2 = await run(['adr', 'import'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([[a]])
    expect(imports()[0]?.headers['spoor-import-edges']).toBeUndefined()
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('a pass-2 unresolved relation while another file failed keeps the entry for the next run', async () => {
    const repo = adrRepo(2)
    const a = 'docs/adr/0001-a.md'
    const b = 'docs/adr/0002-a.md'
    srv.on(IMPORT, (q) =>
      q.headers['spoor-import-edges'] === 'defer'
        ? answer(q, (p) =>
            p === a
              ? { warnings: [{ code: 'edges_deferred' }] }
              : { error: 'internal', message: 'Internal error.' },
          )
        : answer(q, () => ({
            status: 'unchanged',
            warnings: [{ code: 'unresolved_relation', ref: 'ADR-0002' }],
          })),
    )
    const r1 = await run(['adr', 'import'], { cwd: repo })
    expect(r1.code).toBe(2)
    expect(r1.out).toContain(`warning: ${a}: unresolved relation ADR-0002`)
    expect(r1.out).toContain('0 of 2 files imported, 2 remaining. Run the same command again to resume.')
    expect(readImportQueue(repo).adr?.entries[a]?.status).toBe('edges')
    expect(readImportQueue(repo).adr?.entries[b]?.status).toBe('failed')

    srv.requests.length = 0
    srv.on(IMPORT, (q) => answer(q))
    const r2 = await run(['adr', 'import'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([[b], [a]])
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('links naming a repo ADR that failed pass 1 are held back, never sent; the next run imports it, then the links', async () => {
    const a = 'docs/adr/0001-a.md'
    const b = 'docs/adr/0002-b.md'
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: { [a]: '---\nsupersedes: ADR-0002\n---\n# A\n', [b]: '# B\n' },
    })
    srv.on(IMPORT, (q) =>
      answer(q, (p) =>
        p === b
          ? { error: 'internal', message: 'Internal error.' }
          : { warnings: [{ code: 'edges_deferred' }] },
      ),
    )
    const r1 = await run(['adr', 'import'], { cwd: repo })
    expect(r1.code).toBe(2)
    // every request was pass 1: the supersedes of A never reached the server while B is missing
    expect(imports().every((q) => q.headers['spoor-import-edges'] === 'defer')).toBe(true)
    expect(r1.out).toContain(`note: the links of ${a} wait until ${b} is imported`)
    expect(r1.out).toContain('0 of 2 files imported, 2 remaining. Run the same command again to resume.')
    expect(readImportQueue(repo).adr?.entries[a]?.status).toBe('edges')

    srv.requests.length = 0
    srv.on(IMPORT, (q) => answer(q, () => ({ status: 'unchanged' })))
    const r2 = await run(['adr', 'import'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([[b], [a]])
    expect(imports()[1]?.headers['spoor-import-edges']).toBeUndefined()
    expect(existsSync(queueFile(repo))).toBe(false)
  })

  it('a refused file does not keep the import unfinished; an unresolved ref then ends done', async () => {
    const a = 'docs/adr/0001-a.md'
    const big = 'docs/adr/0002-big.md'
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: { [a]: '# A\n', [big]: `# Big\n${'x'.repeat(400_001)}` },
    })
    srv.on(IMPORT, (q) => answer(q, () => ({ warnings: [{ code: 'unresolved_relation', ref: 'ADR-0099' }] })))
    const r1 = await run(['adr', 'import'], { cwd: repo })
    expect(r1.code).toBe(2)
    expect(r1.out).toContain(
      '1 of 2 files imported, 1 remaining. 1 file was refused; fix it, then run the command again.',
    )
    expect(r1.out).not.toContain('Run the same command again to resume.')
    expect(readImportQueue(repo).adr?.entries[a]?.status).toBe('done')
    expect((await run(['status'], { cwd: repo })).out).not.toContain('Unfinished import')

    // once the file changes it is work a re-run can finish again
    writeFile(repo, big, '# Big\nsmaller now\n')
    expect((await run(['status'], { cwd: repo })).out).toContain(
      'Unfinished import (adr): 1 of 2 files remaining; run: spoor adr import',
    )
  })

  it('reserve_above counts the files skipped as already imported', async () => {
    const hi = 'docs/adr/0030-a.md'
    const lo = 'docs/adr/0002-b.md'
    const repo = makeRepo({ local: localEnv(srv.url), files: { [hi]: '# Thirty\n', [lo]: '# Two\n' } })
    srv.on(IMPORT, (q) =>
      answer(q, (p) => (p === lo ? { error: 'internal', message: 'Internal error.' } : {})),
    )
    expect((await run(['adr', 'import'], { cwd: repo })).code).toBe(2)
    srv.requests.length = 0
    srv.on(IMPORT, (q) => answer(q))
    const r2 = await run(['adr', 'import'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(imports().map(pathsOf)).toEqual([[lo]])
    expect(bodyOf<{ reserve_above: number }>(imports()[0] as Req).reserve_above).toBe(30)
    expect(r2.out).toContain('1 already imported and unchanged')
  })

  it('a lost renumber answered again (status unchanged) renames the file and pass 2 sends the new path', async () => {
    const repo = adrRepo(2)
    srv.on(IMPORT, (q) =>
      q.headers['spoor-import-edges'] === 'defer'
        ? answer(q, (p) =>
            p.endsWith('0002-a.md') ? { status: 'unchanged', renumbered: { from: 2, to: 3 } } : {},
          )
        : answer(q, () => ({ status: 'unchanged' })),
    )
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(existsSync(join(repo, 'docs/adr/0003-a.md'))).toBe(true)
    expect(existsSync(join(repo, 'docs/adr/0002-a.md'))).toBe(false)
    expect(pathsOf(imports()[1] as Req)).toEqual(['docs/adr/0003-a.md'])
  })
})

describe('import lock', () => {
  it('a live import holding the lock: exit 1, nothing sent', async () => {
    const repo = adrRepo(1)
    writeFile(repo, '.spoor/import.lock', String(process.ppid))
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(r.err).toBe(
      `spoor: another import is running in this checkout (pid ${process.ppid}). Wait for it to finish, then run the command again.\n`,
    )
    expect(srv.requests).toHaveLength(0)
    expect(readFileSync(lockFile(repo), 'utf8')).toBe(String(process.ppid))
  })

  it('hooks skip the network push while an import holds the lock', async () => {
    const repo = adrRepo(1)
    writeFile(repo, '.spoor/import.lock', String(process.ppid))
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    srv.on(PUSH, { body: res({}) })
    const s = await run(['hook', 'session-start'], {
      cwd: repo,
      stdin: JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' }),
    })
    expect(s.out).toContain('digest\n')
    expect(srv.count(PUSH)).toBe(0)
    const p = await run(['hook', 'post-tool-use'], {
      cwd: repo,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        cwd: repo,
        tool_input: { file_path: join(repo, 'docs/adr/0001-a.md') },
      }),
    })
    expect(p.out).toBe('')
    expect(srv.count(PUSH)).toBe(0)
    expect(readState(repo).pending.map((x) => x.path)).toEqual(['docs/adr/0001-a.md'])
  })

  it('takes over a lock of a dead pid or one not touched for 11 minutes; removes it after the run', async () => {
    const repo = adrRepo(1)
    srv.on(IMPORT, (q) => answer(q))
    writeFile(repo, '.spoor/import.lock', '999999')
    expect((await run(['adr', 'import', '--all'], { cwd: repo })).code).toBe(0)
    expect(existsSync(lockFile(repo))).toBe(false)
    writeFile(repo, '.spoor/import.lock', String(process.ppid))
    const old = (Date.now() - 11 * 60 * 1000) / 1000
    utimesSync(lockFile(repo), old, old)
    expect((await run(['adr', 'import', '--all'], { cwd: repo })).code).toBe(0)
    expect(existsSync(lockFile(repo))).toBe(false)
    expect(imports()).toHaveLength(2)
  })

  it('the held lock is refreshed every minute, so a long request never makes it look stale', async () => {
    const repo = adrRepo(1)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const t = Date.now() + 5 * 60 * 1000
      const lock = acquireImportLock(repo, Date.now(), () => t)
      expect(isImportLock(lock)).toBe(true)
      const old = (Date.now() - 9 * 60 * 1000) / 1000
      utimesSync(lockFile(repo), old, old)
      vi.advanceTimersByTime(60_000)
      expect(Math.round(statSync(lockFile(repo)).mtimeMs / 1000)).toBe(Math.round(t / 1000))
      if (isImportLock(lock)) lock.release()
      expect(existsSync(lockFile(repo))).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a lock taken over during the run stops the import', async () => {
    const repo = adrRepo(25)
    srv.on(IMPORT, (q) => {
      writeFileSync(lockFile(repo), String(process.ppid))
      return answer(q)
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(imports()).toHaveLength(1)
    expect(r.err).toContain(
      'spoor: another import took over this checkout; this one stopped. Run the same command again to resume.\n',
    )
  })
})

describe('unfinished import', () => {
  const queue = (updatedAt: string) =>
    JSON.stringify({
      version: 1,
      adr: {
        started_at: updatedAt,
        updated_at: updatedAt,
        entries: { 'docs/adr/0001-a.md': { status: 'pending', sha256: 'x', attempts: 0 } },
      },
    })

  it('the sweep leaves its files to the import; status and SessionStart mention it; after 7 days the sweep pushes', async () => {
    const repo = adrRepo(1)
    writeFile(repo, '.spoor/import-queue.json', queue(new Date().toISOString()))
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    srv.on(PUSH, (q) => ({
      body: res({ source_path: bodyOf<{ source_path: string }>(q).source_path, spoor_id: uuid() }),
    }))
    const stdin = JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' })
    const s = await run(['hook', 'session-start'], { cwd: repo, stdin })
    expect(srv.count(PUSH)).toBe(0)
    expect(s.out).toContain(
      'Spoor: an import of this repo is unfinished (1 of 1 files remaining). Ask the user to run spoor adr import.',
    )
    const st = await run(['status'], { cwd: repo })
    expect(st.out).toContain('Unfinished import (adr): 1 of 1 files remaining; run: spoor adr import')

    writeFile(
      repo,
      '.spoor/import-queue.json',
      queue(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()),
    )
    await run(['hook', 'session-start'], { cwd: repo, stdin: JSON.stringify({ session_id: 't', cwd: repo }) })
    expect(srv.count(PUSH)).toBe(1)
  })

  it('PostToolUse queues a file of the unfinished import and SessionStart does not replay it; after 7 days it does', async () => {
    const repo = adrRepo(1)
    writeFile(repo, '.spoor/import-queue.json', queue(new Date().toISOString()))
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    srv.on(PUSH, (q) => ({
      body: res({ source_path: bodyOf<{ source_path: string }>(q).source_path, spoor_id: uuid() }),
    }))
    const p = await run(['hook', 'post-tool-use'], {
      cwd: repo,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        cwd: repo,
        tool_input: { file_path: join(repo, 'docs/adr/0001-a.md') },
      }),
    })
    expect(p.out).toBe('')
    expect(srv.count(PUSH)).toBe(0)
    expect(readState(repo).pending.map((x) => x.path)).toEqual(['docs/adr/0001-a.md'])
    const stdin = JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' })
    await run(['hook', 'session-start'], { cwd: repo, stdin })
    expect(srv.count(PUSH)).toBe(0)
    expect(readState(repo).pending.map((x) => x.path)).toEqual(['docs/adr/0001-a.md'])

    writeFile(
      repo,
      '.spoor/import-queue.json',
      queue(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()),
    )
    await run(['hook', 'session-start'], { cwd: repo, stdin: JSON.stringify({ session_id: 't', cwd: repo }) })
    expect(srv.count(PUSH)).toBe(1)
  })

  it('a corrupt queue file reads as empty', async () => {
    const repo = adrRepo(1)
    writeFile(repo, '.spoor/import-queue.json', '{not json')
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    const s = await run(['hook', 'session-start'], {
      cwd: repo,
      stdin: JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' }),
    })
    expect(s.out).toContain('digest')
    expect((await run(['status'], { cwd: repo })).out).not.toContain('Unfinished import')
  })
})

describe('docs import', () => {
  const docRepo = () =>
    makeRepo({
      local: localEnv(srv.url),
      files: { 'ARCHITECTURE.md': '# A\n', 'GLOSSARY.md': '# G\n' },
    })
  const pushRes = (q: Req) => {
    const p = bodyOf<{ source_path: string }>(q).source_path
    return { body: res({ source_path: p, spoor_id: idFor(p), handle: 'd1', space: 'docs' }) }
  }

  it('every push carries Spoor-Defer-Embedding and the size-based timeout (not the 6 s hook timeout)', async () => {
    const repo = docRepo()
    srv.on(PUSH, pushRes)
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    const r = await run(['docs', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(srv.requests.map((q) => q.headers['spoor-defer-embedding'])).toEqual(['1', '1'])
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([30_250, 30_250])
    expect(existsSync(queueFile(repo))).toBe(false)
    const again = await run(['docs', 'import'], { cwd: repo })
    expect(again.out).toContain('2 already imported and unchanged, not sent (--all sends them again)')
  })

  it('a 429 with Retry-After is back-pressure: the same file is sent again, no error', async () => {
    const repo = docRepo()
    let calls = 0
    srv.on(PUSH, (q) =>
      ++calls === 1
        ? {
            status: 429,
            headers: { 'retry-after': '3' },
            body: { error: 'rate_limited', message: 'slow down' },
          }
        : pushRes(q),
    )
    const rec = recorder()
    const r = await run(['docs', 'import'], { cwd: repo, sleep: rec.sleep })
    expect(r.code).toBe(0)
    expect(r.out).toContain('2 created, 0 updated, 0 unchanged, 0 errors')
    expect(srv.requests.map((q) => bodyOf<{ source_path: string }>(q).source_path)).toEqual([
      'ARCHITECTURE.md',
      'ARCHITECTURE.md',
      'GLOSSARY.md',
    ])
    expect(Math.max(...rec.sleeps)).toBeGreaterThanOrEqual(3000)
  })

  it('SPOOR_IMPORT_TIMEOUT_MS sets the request timeout; a timed-out push is retried', async () => {
    const repo = docRepo()
    let calls = 0
    srv.on(PUSH, (q) => ({ ...pushRes(q), ...(++calls === 1 ? { delayMs: 300 } : {}) }))
    const r = await run(['docs', 'import'], { cwd: repo, env: { SPOOR_IMPORT_TIMEOUT_MS: '200' } })
    expect(r.code).toBe(0)
    expect(srv.count(PUSH)).toBe(3)
    expect(r.err).toContain('spoor: request timed out (timeout)')

    calls = 0
    srv.requests.length = 0
    const r2 = await run(['docs', 'import', '--all'], { cwd: repo })
    expect(r2.code).toBe(0)
    expect(srv.count(PUSH)).toBe(2)
    expect(r2.err).toBe('')
  })

  it('hook pushes and spoor docs push send no import header', async () => {
    const repo = docRepo()
    srv.on(PUSH, pushRes)
    await run(['docs', 'push', 'ARCHITECTURE.md'], { cwd: repo })
    await run(['hook', 'post-tool-use'], {
      cwd: repo,
      stdin: JSON.stringify({
        tool_name: 'Write',
        cwd: repo,
        tool_input: { file_path: join(repo, 'GLOSSARY.md') },
      }),
    })
    expect(srv.count(PUSH)).toBe(2)
    for (const q of srv.requests) expect(q.headers['spoor-defer-embedding']).toBeUndefined()
  })

  it('403 stops the docs import; a conflict is a per-file error', async () => {
    const repo = docRepo()
    srv.on(PUSH, (q) =>
      bodyOf<{ source_path: string }>(q).source_path === 'ARCHITECTURE.md'
        ? {
            status: 409,
            body: { error: 'pushed_over_spoor_edit', message: 'd1 was edited in Spoor', details: {} },
          }
        : pushRes(q),
    )
    const r = await run(['docs', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(r.out).toContain('error ARCHITECTURE.md: d1 was edited in Spoor')
    expect(r.out).toContain('1 created, 0 updated, 0 unchanged, 1 errors')

    srv.requests.length = 0
    srv.on(PUSH, { status: 403, body: { error: 'forbidden', message: 'viewer' } })
    const r2 = await run(['docs', 'import', '--all'], { cwd: repo })
    expect(r2.code).toBe(3)
    expect(srv.count(PUSH)).toBe(1)
    expect(r2.err).toContain(
      'spoor: forbidden: viewer\nspoor: import stopped. 0 of 2 files imported, 2 remaining.',
    )
  })
})
