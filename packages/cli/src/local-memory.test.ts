/** Memory files from before Spoor (ADR-0036): the question in `spoor init`, `delete`, and the two-way `sync`. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256 } from './fsutil.js'
import { readState, updateState } from './state.js'
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
  srv.on('GET /p/acme/install.json', { body: { version: '0.1.0', project: 'acme' } })
})
afterEach(async () => {
  await srv.close()
})

const MEMORY = '# Memory\n\n- a fact\n'
const read = (repo: string, rel: string) => readFileSync(join(repo, rel), 'utf8')
const config = (repo: string) => JSON.parse(read(repo, 'spoor.config.json'))

/** Answers every push as created/updated, one item per source_path. */
function pushServer() {
  const ids = new Map<string, { id: string; revision: number; handle: string }>()
  srv.on('POST /p/acme/api/push', (req: Req) => {
    const b = req.body as { source_path: string }
    const known = ids.get(b.source_path)
    const item = known
      ? { ...known, revision: known.revision + 1 }
      : { id: uuid(), revision: 1, handle: `d${ids.size + 1}` }
    ids.set(b.source_path, item)
    return {
      body: {
        source_path: b.source_path,
        status: known ? 'updated' : 'created',
        handle: item.handle,
        spoor_id: item.id,
        space: 'docs',
        revision: item.revision,
        renumbered: null,
        warnings: [],
      },
    }
  })
  return ids
}

const repoWithMemory = (cfg?: unknown) =>
  makeRepo({
    local: localEnv(srv.url),
    files: { '.memory/PROJECT_MEMORY.md': MEMORY, 'MEMORY.md': '# Old\n', 'docs/guide.md': '# Guide\n' },
    ...(cfg === undefined ? {} : { config: cfg }),
  })

const hook = (name: string, repo: string, input: Record<string, unknown>) =>
  run(['hook', name], { cwd: repo, stdin: JSON.stringify({ cwd: repo, ...input }) })

describe('spoor init and memory files from before Spoor', () => {
  it('without a terminal it names the files and the two choices, and changes nothing', async () => {
    const repo = repoWithMemory()
    const r = await run(['init'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Found 2 memory files from before Spoor: .memory/PROJECT_MEMORY.md, MEMORY.md\n')
    expect(r.out).toContain('spoor init --local-memory sync')
    expect(config(repo)).toEqual({})
    expect(existsSync(join(repo, 'MEMORY.md'))).toBe(true)
    expect(srv.count('POST /p/acme/api/push')).toBe(0)
  })

  it('asks on a terminal; Enter decides later, d imports the files and deletes them', async () => {
    const repo = repoWithMemory()
    pushServer()
    const later = await run(['init'], { cwd: repo, isTTY: true, prompt: async () => '' })
    expect(later.out).toContain('Nothing was changed')
    expect(config(repo)).toEqual({})

    const questions: string[] = []
    const r = await run(['init'], {
      cwd: repo,
      isTTY: true,
      prompt: async (q) => {
        questions.push(q)
        return 'd'
      },
    })
    expect(r.code).toBe(0)
    expect(questions).toHaveLength(1)
    expect(r.out).toContain('updated spoor.config.json (local_memory.mode: delete); commit it\n')
    expect(r.out).toContain('imported .memory/PROJECT_MEMORY.md as d1, deleted the file\n')
    expect(r.out).toContain('imported MEMORY.md as d2, deleted the file\n')
    expect(config(repo).local_memory).toEqual({ mode: 'delete' })
    expect(existsSync(join(repo, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(repo, '.memory'))).toBe(false) // the emptied directory goes too
    expect(existsSync(join(repo, 'docs/guide.md'))).toBe(true)
    const pushes = srv.requests.filter((q) => q.path === '/p/acme/api/push')
    expect(bodyOf<{ space: string; content: string }>(pushes[0])).toMatchObject({
      space: 'docs',
      content: MEMORY,
    })
    // no base is kept: the deleted files are not reported as orphaned mirror files
    expect(readState(repo).bases).toEqual({})
    // the answer is stored: the next init does not ask
    const again = await run(['init'], { cwd: repo, isTTY: true, prompt: async () => 'x' })
    expect(again.out).not.toContain('Found')
  })

  it('delete keeps a file the server did not take', async () => {
    const repo = repoWithMemory()
    srv.on('POST /p/acme/api/push', (req: Req) =>
      (req.body as { source_path: string }).source_path === 'MEMORY.md'
        ? { status: 400, body: { error: 'invalid_input', message: 'no' } }
        : {
            body: {
              status: 'created',
              handle: 'd1',
              spoor_id: uuid(),
              space: 'docs',
              revision: 1,
              renumbered: null,
              warnings: [],
            },
          },
    )
    const r = await run(['init', '--local-memory', 'delete'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(r.err).toContain('error MEMORY.md: invalid_input: no')
    expect(existsSync(join(repo, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(repo, '.memory/PROJECT_MEMORY.md'))).toBe(false)
  })

  it('delete removes nothing when the server is unreachable or nobody is logged in', async () => {
    const dead = await deadUrl()
    const repo = makeRepo({
      local: localEnv(dead),
      files: { 'MEMORY.md': MEMORY },
      config: { local_memory: { mode: 'delete' } },
    })
    // init itself cannot reach the server either: it stops before the memory step
    expect((await run(['init'], { cwd: repo })).code).toBe(3)
    expect(existsSync(join(repo, 'MEMORY.md'))).toBe(true)

    const anon = makeRepo({ files: { 'MEMORY.md': MEMORY } })
    const r = await run(['init', '--server', srv.url, '--project', 'acme', '--local-memory', 'delete'], {
      cwd: anon,
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain('local memory files were not imported or deleted')
    expect(existsSync(join(anon, 'MEMORY.md'))).toBe(true)
  })

  it('--local-memory sync stores the answer and pushes the files; a bad value exits 1', async () => {
    const repo = repoWithMemory()
    pushServer()
    expect((await run(['init', '--local-memory', 'both'], { cwd: repo })).code).toBe(1)
    const r = await run(['init', '--local-memory', 'sync'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.out).toContain('pushed .memory/PROJECT_MEMORY.md (d1)\n')
    expect(config(repo).local_memory).toEqual({ mode: 'sync' })
    expect(read(repo, 'MEMORY.md')).toBe('# Old\n')
    expect(
      Object.values(readState(repo).bases)
        .map((b) => b.path)
        .sort(),
    ).toEqual(['.memory/PROJECT_MEMORY.md', 'MEMORY.md'])
    const again = await run(['init'], { cwd: repo })
    expect(again.out).toContain('2 local memory files in sync\n')
  })

  it('--dry-run only says what it would do', async () => {
    const repo = repoWithMemory()
    const r = await run(['init', '--dry-run', '--local-memory', 'delete'], { cwd: repo })
    expect(r.out).toContain('would set local_memory.mode to delete in spoor.config.json\n')
    expect(r.out).toContain('would import and delete MEMORY.md\n')
    expect(config(repo)).toEqual({})
    expect(existsSync(join(repo, 'MEMORY.md'))).toBe(true)
  })
})

describe('local memory files kept in sync', () => {
  const SYNC = { local_memory: { mode: 'sync' } }

  /** A repo whose MEMORY.md was pushed as revision 1 of item `id`. */
  async function synced(content = MEMORY) {
    const repo = makeRepo({
      local: localEnv(srv.url),
      agents: true,
      files: { 'MEMORY.md': content },
      config: SYNC,
    })
    const id = uuid()
    await updateState(repo, (s) => {
      s.bases[id] = { path: 'MEMORY.md', revision: 1, sha256: sha256(content), handle: 'd7', kind: 'doc' }
    })
    srv.on('GET /p/acme/api/context', { text: 'DIGEST\n' })
    return { repo, id }
  }

  it('an edit of the file is pushed by the PostToolUse hook, to the docs space', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'MEMORY.md': MEMORY }, config: SYNC })
    pushServer()
    await hook('post-tool-use', repo, {
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'MEMORY.md') },
    })
    const push = srv.requests.find((q) => q.path === '/p/acme/api/push')
    expect(bodyOf<{ space: string; source_path: string }>(push)).toMatchObject({
      space: 'docs',
      source_path: 'MEMORY.md',
    })
    // without the choice the same file is nobody's business
    const plain = makeRepo({ local: localEnv(srv.url), files: { 'MEMORY.md': MEMORY } })
    const before = srv.count('POST /p/acme/api/push')
    await hook('post-tool-use', plain, {
      tool_name: 'Edit',
      tool_input: { file_path: join(plain, 'MEMORY.md') },
    })
    expect(srv.count('POST /p/acme/api/push')).toBe(before)
  })

  it('session start pulls a newer text from Spoor into an unchanged file, keeping its frontmatter', async () => {
    const original = `---\ntags: [memory]\n---\n${MEMORY}`
    const { repo, id } = await synced(original)
    srv.on('GET /p/acme/api/pull', {
      body: { spoor_id: id, revision: 3, body: '# Memory\n\n- edited in the web UI' },
    })
    const r = await hook('session-start', repo, { session_id: 's1', source: 'startup' })
    expect(r.out).toContain('Spoor: MEMORY.md was updated from Spoor (edited there since the last sync).\n')
    const next = '---\ntags: [memory]\n---\n# Memory\n\n- edited in the web UI\n'
    expect(read(repo, 'MEMORY.md')).toBe(next)
    expect(readState(repo).bases[id]).toMatchObject({ revision: 3, sha256: sha256(next), handle: 'd7' })
    // the pulled text is not pushed back
    expect(srv.count('POST /p/acme/api/push')).toBe(0)
    expect(srv.requests.find((q) => q.path === '/p/acme/api/pull')?.query.get('source_path')).toBe(
      'MEMORY.md',
    )
    // nothing newer: nothing happens
    const again = await hook('session-start', repo, { session_id: 's2', source: 'startup' })
    expect(again.out).toBe('DIGEST\n')
  })

  it('does not pull when the revision is not newer, the server has no pull route, or the answer is odd', async () => {
    const { repo, id } = await synced()
    srv.on('GET /p/acme/api/pull', { body: { spoor_id: id, revision: 1, body: 'other' } })
    await hook('session-start', repo, { session_id: 's1', source: 'startup' })
    expect(read(repo, 'MEMORY.md')).toBe(MEMORY)
    srv.on('GET /p/acme/api/pull', { body: { spoor_id: '../x', revision: 9, body: 'evil' } })
    await hook('session-start', repo, { session_id: 's2', source: 'startup' })
    expect(read(repo, 'MEMORY.md')).toBe(MEMORY)
    srv.routes.delete('GET /p/acme/api/pull') // an older server: 404 for the route
    const r = await hook('session-start', repo, { session_id: 's3', source: 'startup' })
    expect(r.out).toBe('DIGEST\n')
    expect(read(repo, 'MEMORY.md')).toBe(MEMORY)
  })

  it('a file changed on both sides is a conflict; --take-server resolves it with the text in Spoor', async () => {
    const { repo, id } = await synced()
    writeFile(repo, 'MEMORY.md', '# Memory\n\n- local edit\n')
    srv.on('GET /p/acme/api/pull', { body: { spoor_id: id, revision: 2, body: '# Memory\n\n- web edit' } })
    srv.on('POST /p/acme/api/push', {
      status: 409,
      body: {
        error: 'pushed_over_spoor_edit',
        message: 'd7 was edited in Spoor',
        details: { edited_by: 'ann' },
      },
    })
    const start = await hook('session-start', repo, { session_id: 's1', source: 'startup' })
    expect(start.out).toContain(
      '1 repo file not pushed because it was edited in the Spoor web UI: MEMORY.md (d7)',
    )
    expect(read(repo, 'MEMORY.md')).toBe('# Memory\n\n- local edit\n') // the local edit is never overwritten silently
    expect(srv.count('GET /p/acme/api/pull')).toBe(0)

    const plain = await run(['memory', 'sync'], { cwd: repo })
    expect(plain.code).toBe(2)
    expect(plain.err).toContain('conflict MEMORY.md: d7 was edited in Spoor and the file changed too')

    const r = await run(['memory', 'sync', '--take-server'], { cwd: repo })
    expect(r.code).toBe(0)
    expect(r.out).toContain('pulled MEMORY.md (Spoor had a newer text)\n')
    expect(read(repo, 'MEMORY.md')).toBe('# Memory\n\n- web edit\n')
    expect(readState(repo).conflicts).toEqual([])
  })

  it('--take-local overwrites Spoor after a typed confirmation', async () => {
    const { repo } = await synced()
    writeFile(repo, 'MEMORY.md', '# Memory\n\n- local edit\n')
    await updateState(repo, (s) => {
      s.conflicts.push({
        path: 'MEMORY.md',
        handle: 'd7',
        since: '2026-11-16T00:00:00Z',
        edited_by: null,
        sha256: sha256('# Memory\n\n- local edit\n'),
      })
    })
    pushServer()
    expect((await run(['memory', 'sync', '--take-local'], { cwd: repo })).code).toBe(1) // no terminal
    const no = await run(['memory', 'sync', '--take-local'], {
      cwd: repo,
      isTTY: true,
      prompt: async () => 'n',
    })
    expect(no.code).toBe(2)
    expect(srv.count('POST /p/acme/api/push')).toBe(0)
    const yes = await run(['memory', 'sync', '--take-local'], {
      cwd: repo,
      isTTY: true,
      prompt: async () => 'y',
    })
    expect(yes.code).toBe(0)
    expect(bodyOf<{ force?: boolean }>(srv.requests.find((q) => q.path === '/p/acme/api/push')).force).toBe(
      true,
    )
    expect(readState(repo).conflicts).toEqual([])
  })

  it('spoor memory sync needs the sync choice', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), files: { 'MEMORY.md': MEMORY } })
    const r = await run(['memory', 'sync'], { cwd: repo })
    expect(r.code).toBe(1)
    expect(r.err).toContain('spoor init --local-memory sync')
  })
})

describe('session start and undecided memory files', () => {
  it('tells the agent to ask the user, once a day; delete mode asks for spoor init', async () => {
    const repo = makeRepo({ local: localEnv(srv.url), agents: true, files: { 'MEMORY.md': MEMORY } })
    srv.on('GET /p/acme/api/context', { text: 'DIGEST\n' })
    const r = await hook('session-start', repo, { session_id: 's1', source: 'startup' })
    expect(r.out).toBe(
      'Spoor: this repo still has 1 memory file from before Spoor (MEMORY.md). Ask the user whether to delete it (after importing into Spoor) or keep it in sync with Spoor, then run: spoor init --local-memory delete (or sync).\nDIGEST\n',
    )
    expect((await hook('session-start', repo, { session_id: 's2', source: 'startup' })).out).toBe('DIGEST\n')
    expect(read(repo, 'MEMORY.md')).toBe(MEMORY) // a hook never deletes

    const del = makeRepo({
      local: localEnv(srv.url),
      agents: true,
      files: { 'MEMORY.md': MEMORY },
      config: { local_memory: { mode: 'delete' } },
    })
    const d = await hook('session-start', del, { session_id: 's1', source: 'startup' })
    expect(d.out).toContain('1 local memory file is in the repo again (MEMORY.md)')
    expect(d.out).toContain('Ask the user to run spoor init.')
    expect(existsSync(join(del, 'MEMORY.md'))).toBe(true)
  })
})
