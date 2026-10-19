import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adrFileName,
  buildStdin,
  type DecisionMemory,
  DRAFT_INSTRUCTION,
  fallbackBody,
  RETRY_SUFFIX,
  relatedFiles,
  validateAdrBody,
} from './cmd/draft.js'
import { readState, updateState } from './state.js'
import {
  bodyOf,
  type FakeServer,
  fakeServer,
  localEnv,
  makeRepo,
  run,
  uuid,
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

const m59: DecisionMemory = {
  handle: 'm59',
  spoor_id: 'x',
  title: 'Use Postgres full-text plus pgvector for search',
  body: 'We compared Elastic and Postgres.\n\nSecond paragraph.',
  tags: ['search'],
  anchors: ['packages/server/src/search/'],
  confidence: 'high',
  created_at: '2026-10-19T14:02:11Z',
}

const GOOD =
  '# Some model title\n\n## Context\nC.\n\n## Decision\nWe will use Postgres.\n\n## Consequences\n- Easier.\n'

/** A fake drafting command: records argv[-1], stdin and SPOOR_DRAFTING per call, answers from answer<N>.md. */
function fakeCommand(answers: string[]): { cmd: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spoor-draft-cmd-'))
  answers.forEach((a, i) => {
    writeFileSync(join(dir, `answer${i + 1}.md`), a)
  })
  const script = join(dir, 'fake.sh')
  writeFileSync(
    script,
    `#!/bin/sh
d="${dir}"
n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$d/count"
for last in "$@"; do :; done
printf '%s' "$last" > "$d/arg$n.txt"
cat > "$d/stdin$n.txt"
printf '%s' "$SPOOR_DRAFTING" > "$d/env$n.txt"
f="$d/answer$n.md"; [ -f "$f" ] || f="$d/answer${answers.length}.md"
cat "$f"
`,
  )
  chmodSync(script, 0o755)
  return { cmd: script, dir }
}

const pushOk = (over: Record<string, unknown> = {}) => ({
  status: 'created',
  handle: 'ADR-0015',
  spoor_id: uuid(),
  space: 'decisions',
  revision: 1,
  number: 15,
  adr_number: 15,
  renumbered: null,
  warnings: [],
  ...over,
})

function serverWith(items: DecisionMemory[], push: () => unknown = () => ({ body: pushOk() })) {
  srv.on('GET /p/acme/api/whoami', {
    body: whoami({ project: { slug: 'acme', name: 'Acme', next_adr_number: 15 } }),
  })
  srv.on('GET /p/acme/api/decisions/undrafted', { body: { items } })
  srv.on('POST /p/acme/api/push', push as never)
}

const NOW = () => Date.parse('2026-10-19T12:00:00Z')

describe('spoor adr draft', () => {
  it('drafts with the configured command, writes the proposed ADR, pushes it, writes spoor_id back', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0003-old.md': '# Old\n' } })
    const fake = fakeCommand([GOOD])
    const id = uuid()
    serverWith([m59], () => ({ body: pushOk({ spoor_id: id }) }))
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const rel = 'docs/adr/0015-use-postgres-full-text-plus-pgvector-for-search.md'
    expect(r.out).toBe(`m59 → ${rel} (ADR-0015 r1, proposed)\n`)
    expect(readFileSync(join(fake.dir, 'arg1.txt'), 'utf8')).toBe(DRAFT_INSTRUCTION)
    expect(readFileSync(join(fake.dir, 'stdin1.txt'), 'utf8')).toBe(buildStdin(m59, []))
    expect(readFileSync(join(fake.dir, 'env1.txt'), 'utf8')).toBe('1')
    const pushed = srv.requests.find((q) => q.path.endsWith('/push'))?.body as {
      content: string
      source_path: string
      base_revision?: number
    }
    expect(pushed.source_path).toBe(rel)
    expect(pushed.base_revision).toBeUndefined()
    const expected =
      '---\nadr: 15\ntitle: Use Postgres full-text plus pgvector for search\nstatus: proposed\ndate: 2026-10-19\n' +
      'deciders: [ann@example.com]\ndrafted_from: [m59]\ntags: [search]\nanchors: [packages/server/src/search/]\n---\n' +
      '# Use Postgres full-text plus pgvector for search\n\n## Context\nC.\n\n## Decision\nWe will use Postgres.\n\n## Consequences\n- Easier.\n'
    expect(pushed.content).toBe(expected)
    expect(readFileSync(join(repo, rel), 'utf8')).toBe(
      expected.replace('---\nadr: 15', `---\nspoor_id: ${id}\nadr: 15`),
    )
    expect(readState(repo).drafted.m59).toEqual({ path: rel, pushed: true, adr: 'ADR-0015' })
    expect(srv.requests.find((q) => q.path.endsWith('/undrafted'))?.query.get('mine')).toBe('true')
    // drafting pushes are the CLI's own: marked automatic so they never suppress the Stop nag (A3)
    expect(srv.requests.find((q) => q.path.endsWith('/push'))?.headers['user-agent']).toMatch(/ \(auto\)$/)
  })

  it('retries once with the format reminder, then writes the mechanical fallback', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const fake = fakeCommand(['no heading here', 'still wrong'])
    serverWith([m59])
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.out).toContain('wrote the fallback template')
    expect(readFileSync(join(fake.dir, 'arg2.txt'), 'utf8')).toBe(DRAFT_INSTRUCTION + RETRY_SUFFIX)
    expect(readFileSync(join(fake.dir, 'stdin2.txt'), 'utf8')).toBe(
      readFileSync(join(fake.dir, 'stdin1.txt'), 'utf8'),
    )
    const content = bodyOf<{ content: string }>(srv.requests.find((q) => q.path.endsWith('/push'))).content
    expect(content.split('---\n')[2]).toBe(`${fallbackBody(m59)}\n`)
    expect(readState(repo).drafted.m59?.fallback).toBe(true)
    expect(fallbackBody(m59)).toBe(
      '# Use Postgres full-text plus pgvector for search\n\n## Context\nRecorded as a decision note on 2026-10-19 (m59). We compared Elastic and Postgres.\n\n## Decision\nUse Postgres full-text plus pgvector for search\n\n## Consequences\nNot written yet. This ADR was created without a model; edit it.',
    )
  })

  it('JSON output mode: takes .result, treats is_error as a failure', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const ok = fakeCommand([
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: GOOD }),
    ])
    serverWith([m59])
    await run(['adr', 'draft'], {
      cwd: repo,
      env: { SPOOR_DRAFT_CMD: `${ok.cmd} --output-format json` },
      now: NOW,
    })
    expect(bodyOf<{ content: string }>(srv.requests.find((q) => q.path.endsWith('/push'))).content).toContain(
      'We will use Postgres.',
    )

    const repo2 = makeRepo({ local: localEnv(srv.url) })
    const bad = fakeCommand([
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }),
    ])
    const r = await run(['adr', 'draft'], {
      cwd: repo2,
      env: { SPOOR_DRAFT_CMD: `${bad.cmd} --output-format json` },
      now: NOW,
    })
    expect(r.out).toContain('model reported an error')
    expect(existsSync(join(bad.dir, 'arg2.txt'))).toBe(false) // an error is not retried
  })

  it('a missing command falls back too (spoor.config.json draft.command)', async () => {
    const repo = makeRepo({
      local: localEnv(srv.url),
      config: { draft: { command: ['/nonexistent/claude', '-p'] } },
    })
    serverWith([m59])
    const r = await run(['adr', 'draft'], { cwd: repo, now: NOW })
    expect(r.out).toMatch(/drafting command failed \(cannot start/)
    expect(srv.count('POST /p/acme/api/push')).toBe(1)
  })

  it('409 already_drafted deletes the local draft and records the memory as drafted', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const fake = fakeCommand([GOOD])
    serverWith([m59], () => ({
      status: 409,
      body: { error: 'already_drafted', details: { handle: 'm59', adr: 'ADR-0016' } },
    }))
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.out).toBe('m59 already drafted as ADR-0016 elsewhere\n')
    expect(existsSync(join(repo, 'docs/adr/0015-use-postgres-full-text-plus-pgvector-for-search.md'))).toBe(
      false,
    )
    expect(readState(repo).drafted.m59?.pushed).toBe(true)
  })

  it('at most max_per_run, oldest first; a second run never redrafts a pushed memory', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const fake = fakeCommand([GOOD])
    const mems = ['m1', 'm2', 'm3'].map((h, i) => ({ ...m59, handle: h, title: `Decision ${i + 1}` }))
    let n = 14
    serverWith(mems, () => ({ body: pushOk({ handle: `ADR-00${++n}` }) }))
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.out).toBe(
      'm1 → docs/adr/0015-decision-1.md (ADR-0015 r1, proposed)\nm2 → docs/adr/0016-decision-2.md (ADR-0016 r1, proposed)\n',
    )
    const again = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(again.out).toBe('m3 → docs/adr/0017-decision-3.md (ADR-0017 r1, proposed)\n')
    expect(srv.count('POST /p/acme/api/push')).toBe(3)
  })

  it('a draft whose push failed is pushed (not redrafted) by the next run', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const fake = fakeCommand([GOOD])
    let fail = true
    serverWith([m59], () => (fail ? { status: 503, body: { error: 'starting' } } : { body: pushOk() }))
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.out).toContain('not pushed: server unreachable; queued')
    expect(readState(repo).drafted.m59?.pushed).toBe(false)
    expect(readState(repo).pending).toHaveLength(1)
    fail = false
    const { rmSync } = await import('node:fs')
    rmSync(join(repo, '.spoor/offline-until'))
    const again = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(again.out).toBe(
      'm59 → docs/adr/0015-use-postgres-full-text-plus-pgvector-for-search.md (ADR-0015 r1, proposed)\n',
    )
    expect(readFileSync(join(fake.dir, 'count'), 'utf8').trim()).toBe('1') // the model ran once
  })

  it('skips when CI is set, when drafting is disabled, when SPOOR_DRAFTING=1, or when the lock is held', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    serverWith([m59])
    const ci = await run(['adr', 'draft'], { cwd: repo, env: { CI: 'true' } })
    expect(ci.out).toContain('CI is set')
    expect((await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFTING: '1' } })).out).toBe('')
    writeFile(repo, '.spoor/draft.lock', String(process.pid))
    expect((await run(['adr', 'draft'], { cwd: repo })).out).toContain('another drafting run is active')
    const off = makeRepo({ local: localEnv(srv.url), config: { draft: { enabled: false } } })
    expect((await run(['adr', 'draft'], { cwd: off })).out).toContain('disabled')
    expect(srv.requests).toHaveLength(0)
  })

  it('--background logs to last-run.log instead of stdout and releases the lock', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    const fake = fakeCommand([GOOD])
    serverWith([m59])
    const r = await run(['adr', 'draft', '--background', '--session', 'abc'], {
      cwd: repo,
      env: { SPOOR_DRAFT_CMD: fake.cmd },
      now: NOW,
    })
    expect(r.out).toBe('')
    expect(readFileSync(join(repo, '.spoor/last-run.log'), 'utf8')).toMatch(/m59 → docs\/adr\/0015-/)
    expect(existsSync(join(repo, '.spoor/draft.lock'))).toBe(false)
  })

  it('--dry-run prints the prompt and writes nothing', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    serverWith([m59])
    const r = await run(['adr', 'draft', '--dry-run'], { cwd: repo })
    expect(r.out).toContain(DRAFT_INSTRUCTION)
    expect(r.out).toContain('<<<NOTE\nHandle: m59')
    expect(srv.count('POST /p/acme/api/push')).toBe(0)
    expect(existsSync(join(repo, 'docs/adr'))).toBe(false)
  })

  it('numbers above both the local files and next_adr_number, skipping taken names', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'docs/adr/0020-x.md': '# x\n' } })
    const fake = fakeCommand([GOOD])
    serverWith([m59])
    await updateState(repo, () => {})
    const r = await run(['adr', 'draft'], { cwd: repo, env: { SPOOR_DRAFT_CMD: fake.cmd }, now: NOW })
    expect(r.out).toContain('docs/adr/0021-use-postgres')
  })
})

describe('drafting helpers', () => {
  it('stdin has the exact section 6.2 shape', () => {
    expect(buildStdin(m59, ['packages/server/src/search/hybrid.ts'])).toBe(
      '<<<NOTE\nHandle: m59\nRecorded: 2026-10-19T14:02:11Z\nConfidence: high\nTags: search\nAnchors: packages/server/src/search/\nTitle: Use Postgres full-text plus pgvector for search\n\nWe compared Elastic and Postgres.\n\nSecond paragraph.\nNOTE>>>\n\nRelated files (context only, may be empty):\npackages/server/src/search/hybrid.ts\n',
    )
  })

  it('related files are the changed files matching an anchor, at most 20', () => {
    const changed = ['packages/server/src/search/hybrid.ts', 'README.md', 'packages/web/x.ts']
    expect(relatedFiles(['packages/server/src/search/'], changed)).toEqual([
      'packages/server/src/search/hybrid.ts',
    ])
    expect(relatedFiles([], changed)).toEqual([])
    expect(
      relatedFiles(
        ['**/*.ts'],
        Array.from({ length: 30 }, (_, i) => `f${i}.ts`),
      ),
    ).toHaveLength(20)
  })

  it('validation strips an outer fence and enforces the rules', () => {
    expect(validateAdrBody(`\`\`\`markdown\n${GOOD}\`\`\``)).toBe(GOOD.trim())
    expect(validateAdrBody('## Decision\nx')).toBeUndefined()
    expect(validateAdrBody('# T\nno decision')).toBeUndefined()
    expect(validateAdrBody(`# T\n## Decision\n${'x'.repeat(8000)}`)).toBeUndefined()
  })

  it('file names stay at 90 characters', () => {
    const name = adrFileName(7, 'a very long title '.repeat(10))
    expect(name.length).toBeLessThanOrEqual(90)
    expect(name.startsWith('0007-a-very-long-title')).toBe(true)
  })
})
