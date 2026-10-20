import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readState, updateState } from './state.js'
import {
  bodyOf,
  deadUrl,
  type FakeServer,
  fakeServer,
  localEnv,
  makeRepo,
  run,
  uuid,
  writeFile,
} from './testing/harness.js'

let srv: FakeServer
beforeEach(async () => {
  srv = await fakeServer()
})
afterEach(async () => {
  await srv.close()
})

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

describe('spoor adr import', () => {
  it('sends one batch with reserve_above, writes spoor_id back, renumbers collisions, summarises', async () => {
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
    const ids = [uuid(), uuid(), uuid()]
    srv.on('POST /p/acme/api/adr/import', (req) => {
      const b = req.body as { files: { source_path: string }[]; reserve_above: number }
      expect(b.reserve_above).toBe(3)
      expect(b.files.map((f) => f.source_path)).toEqual([
        'docs/adr/0001-first.md',
        'docs/adr/0002-second.md',
        'docs/adr/0003-third.md',
      ])
      return {
        body: {
          results: [
            res({ source_path: 'docs/adr/0001-first.md', spoor_id: ids[0] }),
            res({
              source_path: 'docs/adr/0002-second.md',
              spoor_id: ids[1],
              handle: 'ADR-0004',
              renumbered: { from: 2, to: 4 },
              warnings: [{ code: 'ambiguous_ref', ref: 'ADR-0002', candidates: [] }],
            }),
            { source_path: 'docs/adr/0003-third.md', error: 'invalid_input', message: 'bad' },
          ],
        },
      }
    })
    srv.on('POST /p/acme/api/push', (req) => ({
      body: res({
        source_path: (req.body as { source_path: string }).source_path,
        spoor_id: ids[1],
        status: 'updated',
        revision: 2,
      }),
    }))
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
      `---\nspoor_id: ${ids[0]}\n# keep me\nstatus: accepted\n---\n# First\n\nbody\n`,
    )
    expect(readFileSync(join(repo, 'docs/adr/0004-second.md'), 'utf8')).toBe(
      `---\nspoor_id: ${ids[1]}\nadr: 4\n---\n# ADR-0004: Second\n`,
    )
    expect(existsSync(join(repo, 'docs/adr/0002-second.md'))).toBe(false)
    expect(readFileSync(join(repo, 'docs/adr/0003-third.md'), 'utf8')).toBe('# Third\n')
    // follow-up push moves Spoor's source_path to the renamed file
    expect(
      bodyOf<{ source_path: string }>(srv.requests.find((q) => q.path.endsWith('/push'))).source_path,
    ).toBe('docs/adr/0004-second.md')
    expect(readState(repo).bases[ids[1] as string]).toMatchObject({
      path: 'docs/adr/0004-second.md',
      revision: 2,
    })
  })

  it('splits batches at 100 files; --dry-run writes nothing and sends nothing', async () => {
    const files: Record<string, string> = {}
    for (let i = 1; i <= 150; i++) files[`docs/adr/${String(i).padStart(4, '0')}-a.md`] = `# A ${i}\n`
    const repo = makeRepo({ local: localEnv(srv.url), files })
    const dry = await run(['adr', 'import', '--dry-run'], { cwd: repo })
    expect(dry.out).toContain('150 files in 2 request(s), reserve_above 150')
    expect(srv.requests).toHaveLength(0)
    srv.on('POST /p/acme/api/adr/import', (req) => ({
      body: {
        results: (req.body as { files: { source_path: string }[] }).files.map((f) =>
          res({ source_path: f.source_path, status: 'unchanged' }),
        ),
      },
    }))
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(srv.requests.map((q) => (q.body as { files: unknown[] }).files.length)).toEqual([100, 50])
    expect(r.out).toContain('0 created, 0 updated, 150 unchanged, 0 renumbered, 0 errors')
  })

  it('human mode: server down exits 3, not configured exits 1', async () => {
    const repo = makeRepo({ local: localEnv(await deadUrl()), files: { 'docs/adr/0001-a.md': '# A\n' } })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(3)
    expect(r.err).toMatch(/^spoor: server unreachable \(ECONNREFUSED http:\/\/127\.0\.0\.1:\d+\)/)
    const bare = makeRepo({ files: { 'docs/adr/0001-a.md': '# A\n' } })
    const r2 = await run(['adr', 'import'], { cwd: bare })
    expect(r2.code).toBe(1)
    expect(r2.err).toBe(
      'spoor: not configured for this repo (missing SPOOR_URL, SPOOR_PROJECT, SPOOR_TOKEN). Run: spoor login\n',
    )
  })
})

describe('server answers are not trusted with paths or ids (review-log-phase5 S1-S3)', () => {
  it('adr import ignores a result for a path the batch did not send and leaves files outside the repo alone', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'spoor-victim-'))
    writeFileSync(join(outside, 'rc.sh'), 'echo original\n')
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0001-a.md': '# A\n' } })
    const rel = relative(repo, join(outside, 'rc.sh'))
    srv.on('POST /p/acme/api/adr/import', {
      body: {
        results: [
          res({ source_path: rel, spoor_id: uuid() }),
          res({ source_path: 'docs/adr/0001-a.md', spoor_id: 'x\n---\ntouch /tmp/pwned\n#' }),
        ],
      },
    })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(r.out).toContain('error: the server answered for a file this batch did not send; ignored')
    expect(r.out).toContain('error docs/adr/0001-a.md: unexpected import result (spoor_id is not a uuid)')
    expect(readFileSync(join(outside, 'rc.sh'), 'utf8')).toBe('echo original\n')
    expect(readFileSync(join(repo, 'docs/adr/0001-a.md'), 'utf8')).toBe('# A\n')
    expect(readState(repo).bases).toEqual({})
  })

  it('adr push ignores a renumber to a non-number and never moves the file out of adr_dir', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0002-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', {
      body: res({ handle: 'ADR-0002', renumbered: { from: 2, to: '../../ESCAPED' } }),
    })
    const r = await run(['adr', 'push', 'docs/adr/0002-x.md'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid_response')
    expect(readFileSync(join(repo, 'docs/adr/0002-x.md'), 'utf8')).toBe('# X\n')
    expect(existsSync(join(repo, 'ESCAPED-x.md'))).toBe(false)
  })

  it('adr push refuses a spoor_id that would inject frontmatter lines', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0002-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', {
      body: res({ handle: 'ADR-0002', spoor_id: 'abc\nstatus: accepted\ndeciders: [mallory]' }),
    })
    const r = await run(['adr', 'push', 'docs/adr/0002-x.md'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(readFileSync(join(repo, 'docs/adr/0002-x.md'), 'utf8')).toBe('# X\n')
  })

  it('a queued path outside the repo is never read or pushed', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    await updateState(repo, (s) => {
      s.pending.push({ kind: 'adr', path: '../../etc/hosts', since: 'x' })
    })
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    await run(['hook', 'session-start'], {
      cwd: repo,
      stdin: JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' }),
    })
    expect(srv.count('POST /p/acme/api/push')).toBe(0)
    expect(readState(repo).pending).toEqual([])
  })
})

describe('spoor adr push', () => {
  const conflict = {
    status: 409,
    body: {
      error: 'pushed_over_spoor_edit',
      message: 'ADR-0007 was edited in Spoor (by ann@example.com via web) after the last push.',
      details: { current_revision: 5, edited_by: 'ann@example.com', via: 'web' },
    },
  }

  it('prints one line on success', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0007-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', { body: res({ handle: 'ADR-0007', revision: 4, status: 'updated' }) })
    const r = await run(['adr', 'push', 'docs/adr/0007-x.md'], { cwd: repo })
    expect(r).toMatchObject({ code: 0, out: 'ADR-0007 r4 updated\n' })
  })

  it('--quiet suppresses the progress line', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0007-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', { body: res({ handle: 'ADR-0007' }) })
    expect(await run(['adr', 'push', 'docs/adr/0007-x.md', '--quiet'], { cwd: repo })).toMatchObject({
      code: 0,
      out: '',
    })
  })

  it('refuses files outside adr_dir', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'src/x.md': '# X\n' } })
    expect((await run(['adr', 'push', 'src/x.md'], { cwd: repo })).code).toBe(1)
  })

  it('409 conflict: exit 2, nothing written, recorded in state.conflicts', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0007-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', conflict)
    const r = await run(['adr', 'push', 'docs/adr/0007-x.md'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(r.err).toBe(
      'ADR-0007 was edited in Spoor (by ann@example.com via web) after your last push. Nothing was pushed. Resolve it in a terminal with --force, or align the file.\n',
    )
    expect(readFileSync(join(repo, 'docs/adr/0007-x.md'), 'utf8')).toBe('# X\n')
    expect(readState(repo).conflicts[0]).toMatchObject({ path: 'docs/adr/0007-x.md', handle: 'ADR-0007' })
  })

  it('--force needs a TTY and a typed y; success clears the conflict', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0007-x.md': '# X\n' } })
    const noTty = await run(['adr', 'push', 'docs/adr/0007-x.md', '--force'], { cwd: repo })
    expect(noTty.code).toBe(1)
    expect(srv.requests).toHaveLength(0)

    srv.on('POST /p/acme/api/push', (req) =>
      (req.body as { force?: boolean }).force
        ? { body: res({ handle: 'ADR-0007', revision: 6, status: 'updated' }) }
        : conflict,
    )
    const no = await run(['adr', 'push', 'docs/adr/0007-x.md', '--force'], {
      cwd: repo,
      isTTY: true,
      prompt: async () => 'n',
    })
    expect(no.code).toBe(2)
    const questions: string[] = []
    const yes = await run(['adr', 'push', 'docs/adr/0007-x.md', '--force'], {
      cwd: repo,
      isTTY: true,
      prompt: async (q) => {
        questions.push(q)
        return 'y'
      },
    })
    expect(yes.code).toBe(0)
    expect(questions[0]).toContain('by ann@example.com via web')
    expect(readState(repo).conflicts).toEqual([])
  })

  it('agent-facing: server down prints one notice, exits 0, queues; --strict exits 3', async () => {
    const repo = makeRepo({ local: localEnv(await deadUrl()), files: { 'docs/adr/0007-x.md': '# X\n' } })
    const r = await run(['adr', 'push', 'docs/adr/0007-x.md'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.err).toMatch(
      /^spoor: server unreachable \(ECONNREFUSED http:\/\/127\.0\.0\.1:\d+\); skipped\. It will retry on the next session\.\n$/,
    )
    expect(readState(repo).pending.map((p) => p.path)).toEqual(['docs/adr/0007-x.md'])
    const s = await run(['adr', 'push', 'docs/adr/0007-x.md', '--strict'], { cwd: repo })
    expect(s.code).toBe(3)
  })

  it('token rejected names spoor login', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0007-x.md': '# X\n' } })
    srv.on('POST /p/acme/api/push', { status: 401, body: { error: 'invalid_token' } })
    const r = await run(['adr', 'push', 'docs/adr/0007-x.md'], { cwd: repo })
    expect(r).toMatchObject({ code: 0, err: `spoor: token rejected by ${srv.url} (401). Run: spoor login\n` })
  })
})

describe('spoor docs import / push', () => {
  it('one push per file, no write-back by default, bases keep the spoor_id', async () => {
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: {
        'ARCHITECTURE.md': '# A\n',
        'GLOSSARY.md': '# G\n',
        'docs/intro.md': '# I\n',
        'docs/adr/0001-x.md': '# no\n',
        'docs/sub/deep.md': '# no\n',
      },
    })
    const seen: string[] = []
    srv.on('POST /p/acme/api/push', (req) => {
      const b = req.body as { source_path: string; space: string }
      expect(b.space).toBe('docs')
      seen.push(b.source_path)
      return { body: res({ source_path: b.source_path, handle: `d${seen.length}`, space: 'docs' }) }
    })
    const r = await run(['docs', 'import'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(seen).toEqual(['ARCHITECTURE.md', 'GLOSSARY.md', 'docs/intro.md'])
    expect(r.out).toContain('3 created, 0 updated, 0 unchanged, 0 errors')
    expect(readFileSync(join(repo, 'ARCHITECTURE.md'), 'utf8')).toBe('# A\n')
    expect(Object.values(readState(repo).bases).map((b) => b.path)).toEqual([
      'ARCHITECTURE.md',
      'GLOSSARY.md',
      'docs/intro.md',
    ])
  })

  it('detects a local rename by hash and pushes with the old spoor_id; unmatched gone files are orphans', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/runbook-new.md': '# Runbook\n' } })
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const { sha256 } = await import('./fsutil.js')
    await updateState(repo, (s) => {
      s.bases[id] = {
        path: 'docs/runbook.md',
        revision: 3,
        sha256: sha256('# Runbook\n'),
        handle: 'd4',
        kind: 'doc',
      }
      s.bases.other = { path: 'docs/gone.md', revision: 1, sha256: 'zzz', handle: 'd5', kind: 'doc' }
    })
    srv.on('POST /p/acme/api/push', {
      body: res({ spoor_id: id, handle: 'd4', space: 'docs', revision: 4, status: 'updated' }),
    })
    const r = await run(['docs', 'push', 'docs/runbook-new.md'], { cwd: repo })
    expect(r.code).toBe(0)
    const body = srv.requests[0]?.body as { content: string; base_revision: number }
    expect(body.content).toBe(`---\nspoor_id: ${id}\n---\n# Runbook\n`)
    expect(body.base_revision).toBe(3)
    expect(readFileSync(join(repo, 'docs/runbook-new.md'), 'utf8')).toBe('# Runbook\n')
    const st = await run(['status'], { cwd: repo })
    expect(st.code).toBe(2)
    expect(st.out).toContain('docs/gone.md (d5)')
    expect(st.out).not.toContain('docs/runbook.md')
  })

  it('write_back:true writes spoor_id into docs too', async () => {
    const repo = makeRepo({
      local: localEnv(srv.url),
      config: { docs: { write_back: true } },
      files: { 'ARCHITECTURE.md': '# A\n' },
    })
    const id = uuid()
    srv.on('POST /p/acme/api/push', { body: res({ spoor_id: id, handle: 'd1', space: 'docs' }) })
    await run(['docs', 'push', 'ARCHITECTURE.md'], { cwd: repo })
    expect(readFileSync(join(repo, 'ARCHITECTURE.md'), 'utf8')).toBe(`---\nspoor_id: ${id}\n---\n# A\n`)
  })

  it('a queued entry whose file is gone is dropped on replay', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0001-a.md': '# A\n' } })
    await updateState(repo, (s) => {
      s.pending.push({ kind: 'doc', path: 'docs/x.md', since: 'x' })
    })
    rmSync(join(repo, 'docs/adr/0001-a.md'))
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    await run(['hook', 'session-start'], {
      cwd: repo,
      stdin: JSON.stringify({ session_id: 's', cwd: repo, source: 'startup' }),
    })
    expect(readState(repo).pending).toEqual([])
  })
})

describe('invalid spoor.config.json', () => {
  it('human commands exit 1, hooks fall back to defaults', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), config: { bogus: 1 }, agents: true })
    const r = await run(['adr', 'import'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/spoor\.config\.json/)
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    writeFile(repo, 'x', '')
    const h = await run(['hook', 'session-start'], {
      cwd: repo,
      stdin: JSON.stringify({ session_id: 's', cwd: repo }),
    })
    expect(h.out).toBe('digest\n')
  })
})
