import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { updateState } from './state.js'
import {
  deadUrl,
  type FakeServer,
  fakeServer,
  gitCommitAll,
  localEnv,
  makeRepo,
  run,
  whoami,
  writeFile,
} from './testing/harness.js'

let srv: FakeServer
beforeEach(async () => {
  srv = await fakeServer()
})
afterEach(async () => {
  await srv.close()
})

describe('spoor whoami', () => {
  it('prints one line; --json prints the response', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    srv.on('GET /p/acme/api/whoami', { body: whoami() })
    const r = await run(['whoami'], { cwd: repo })
    expect(r).toMatchObject({
      code: 0,
      out: 'ann@example.com · acme · editor · token "claude-code (device 2026-10-19)" spr_Ab12Cd34 · server 0.1.0\n',
    })
    expect(JSON.parse((await run(['whoami', '--json'], { cwd: repo })).out)).toEqual(whoami())
  })

  it('human mode exit codes: 3 rejected or unreachable, 1 not configured', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    srv.on('GET /p/acme/api/whoami', { status: 401, body: { error: 'invalid_token' } })
    const r = await run(['whoami'], { cwd: repo })
    expect(r).toMatchObject({ code: 3, err: `spoor: token rejected by ${srv.url} (401). Run: spoor login\n` })
    expect((await run(['whoami'], { cwd: makeRepo({ local: localEnv(await deadUrl()) }) })).code).toBe(3)
    expect((await run(['whoami'], { cwd: makeRepo() })).code).toBe(1)
  })

  it('refuses to send a token to a server named only in spoor.config.json', async () => {
    const repo = makeRepo({ config: { server: srv.url, project: 'acme' } })
    const r = await run(['whoami'], { cwd: repo, env: { SPOOR_TOKEN: 'spr_fromenv_1234' } })
    expect(r.code).toBe(1)
    expect(r.err).toBe(
      'spoor: SPOOR_URL comes from spoor.config.json, not from where the token is stored; run spoor login\n',
    )
    expect(srv.requests).toHaveLength(0)
  })
})

describe('spoor status', () => {
  it('shows config sources, conflicts with the --force command, queue, orphans; exit 2', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    await updateState(repo, (s) => {
      s.conflicts.push({
        path: 'docs/adr/0007-x.md',
        handle: 'ADR-0007',
        since: '2026-10-19T00:00:00Z',
        edited_by: 'ann@example.com',
      })
      s.pending.push({ kind: 'doc', path: 'ARCHITECTURE.md', since: '2026-10-19T00:00:00Z' })
      s.bases.id1 = { path: 'docs/gone.md', revision: 1, sha256: 'x', handle: 'd9', kind: 'doc' }
      s.drafted.m59 = { path: 'docs/adr/0015-x.md', pushed: false }
    })
    const r = await run(['status'], { cwd: repo })
    expect(r.code).toBe(2)
    expect(r.out).toContain(`server   ${srv.url} (settings.local.json)`)
    expect(r.out).toContain('token    spr_testtoke… (settings.local.json, expiry unknown)')
    expect(r.out).toContain('docs/adr/0007-x.md (ADR-0007) edited in Spoor by ann@example.com')
    expect(r.out).toContain('spoor adr push docs/adr/0007-x.md --force')
    expect(r.out).toContain('ARCHITECTURE.md (since 2026-10-19T00:00:00Z)')
    expect(r.out).toContain('docs/gone.md (d9)')
    expect(r.out).toContain('m59 → docs/adr/0015-x.md')
    expect(r.out).toContain('breaker  closed (hooks use the network)')
    expect(r.out).not.toContain('network  ok')
    expect(srv.requests).toHaveLength(0)
  })

  it('exit 0 when clean; --remote adds whoami with the expiry', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    srv.on('GET /p/acme/api/whoami', {
      body: whoami({ token: { ...whoami().token, expires_at: null } }),
    })
    const r = await run(['status', '--remote'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.out).toContain('remote   ann@example.com · acme · editor')
    expect(r.out).toContain('· no expiry')
  })

  it('shows the role and "no expiry" recorded at login (review-log-phase5 D8, A7)', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    await updateState(repo, (s) => {
      s.login = { prefix: 'spr_testtoke', expires_at: null, at: 'x', no_expiry: true, role: 'viewer' }
    })
    const r = await run(['status'], { cwd: repo })
    expect(r.out).toContain('token    spr_testtoke… (settings.local.json, no expiry)')
    expect(r.out).toContain('role     viewer (at login; --remote asks the server)')
  })

  it('warns when the committed .mcp.json sends the token to another URL (review-log-phase5 S8)', async () => {
    const repo = makeRepo({
      local: localEnv(srv.url),
      files: {
        '.mcp.json': JSON.stringify({ mcpServers: { spoor: { url: 'https://evil.example/p/acme/mcp' } } }),
      },
    })
    const r = await run(['status'], { cwd: repo })
    expect(r.out).toContain(
      `warning  .mcp.json sends the token to https://evil.example/p/acme/mcp, not to ${srv.url}/p/acme/mcp`,
    )
    writeFile(repo, '.mcp.json', JSON.stringify({ mcpServers: { spoor: { url: `${srv.url}/p/acme/mcp` } } }))
    expect((await run(['status'], { cwd: repo })).out).not.toContain('warning')
  })

  it('names only the missing values', async () => {
    const r = await run(['context'], {
      cwd: makeRepo({ local: { SPOOR_URL: srv.url, SPOOR_TOKEN: 'spr_x12345678' } }),
    })
    expect(r.err).toBe('spoor: not configured for this repo (missing SPOOR_PROJECT). Run: spoor login\n')
  })
})

describe('spoor context', () => {
  it('passes query, files and a budget capped at context.max_tokens', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), config: { context: { max_tokens: 2000 } } })
    srv.on('GET /p/acme/api/context', { text: 'digest\n' })
    const r = await run(
      ['context', '--query', 'auth', '--files', 'a.ts,b/c.ts', '--budget', '5000', '--no-shared'],
      { cwd: repo },
    )
    expect(r).toMatchObject({ code: 0, out: 'digest\n' })
    const q = srv.requests[0]?.query
    expect(q?.get('budget')).toBe('2000')
    expect(q?.get('query')).toBe('auth')
    expect(q?.getAll('file')).toEqual(['a.ts', 'b/c.ts'])
    expect(q?.get('include_shared')).toBe('false')
  })

  it('--git collects anchors: uncommitted, untracked, recent commits; noise and deleted files skipped; max_files cap', async () => {
    const repo = makeRepo({
      git: true,
      local: localEnv(srv.url),
      config: { context: { max_files: 3 } },
      files: { 'old.ts': '1', 'committed.ts': '1', 'gone.ts': '1', 'yarn.lock': '1' },
    })
    gitCommitAll(repo)
    writeFile(repo, 'old.ts', '2')
    writeFile(repo, 'untracked.ts', 'u')
    writeFile(repo, '.spoor/x', 'n')
    const { rmSync } = await import('node:fs')
    rmSync(`${repo}/gone.ts`)
    srv.on('GET /p/acme/api/context', { text: 'd\n' })
    await run(['context', '--git'], { cwd: repo })
    expect(srv.requests[0]?.query.getAll('file')).toEqual(['old.ts', 'untracked.ts', 'committed.ts'])
  })

  it('--json asks for format=json and prints the object', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    srv.on('GET /p/acme/api/context', {
      body: { text: 't', budget: 1500, est_tokens: 3, items: [], dropped: 0 },
    })
    const r = await run(['context', '--json'], { cwd: repo })
    expect(srv.requests[0]?.query.get('format')).toBe('json')
    expect(JSON.parse(r.out).budget).toBe(1500)
  })

  it('agent-facing: server down or not configured prints one notice and exits 0', async () => {
    const down = await run(['context'], { cwd: makeRepo({ local: localEnv(await deadUrl()) }) })
    expect(down.code).toBe(0)
    expect(down.out).toBe('')
    expect(down.err.split('\n').filter(Boolean)).toHaveLength(1)
    const bare = await run(['context'], { cwd: makeRepo() })
    expect(bare).toMatchObject({
      code: 0,
      err: 'spoor: not configured for this repo (missing SPOOR_URL, SPOOR_PROJECT, SPOOR_TOKEN). Run: spoor login\n',
    })
    expect((await run(['context', '--strict'], { cwd: makeRepo() })).code).toBe(1)
  })
})
