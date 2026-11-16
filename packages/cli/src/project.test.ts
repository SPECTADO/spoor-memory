/**
 * The project boundary: the root is never the home directory, and outside a project set up for Spoor
 * (`spoor.config.json`, or the `.mcp.json` of an older install) nothing runs and nothing is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRepoRoot, projectInitialized } from './config.js'
import { VERSION } from './ctx.js'
import { type FakeServer, fakeServer, localEnv, makeRepo, run, writeFile } from './testing/harness.js'

let srv: FakeServer
beforeEach(async () => {
  srv = await fakeServer()
})
afterEach(async () => {
  await srv.close()
})

/** A home directory with the global `~/.claude`, and a project folder below it. */
function home(): { home: string; project: string } {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'spoor-home-')))
  mkdirSync(join(h, '.claude'), { recursive: true })
  const project = join(h, 'work', 'app')
  mkdirSync(project, { recursive: true })
  return { home: h, project }
}

const installJson = { version: '0.1.0', project: 'acme' }

describe('the project root', () => {
  it('is never the home directory: ~/.claude is not a project marker', () => {
    const h = home()
    expect(findRepoRoot(h.project, { HOME: h.home })).toBe(h.project)
    expect(findRepoRoot(join(h.home, 'work'), { HOME: h.home })).toBe(join(h.home, 'work'))
    mkdirSync(join(h.project, '.git'))
    mkdirSync(join(h.project, 'src'))
    expect(findRepoRoot(join(h.project, 'src'), { HOME: h.home })).toBe(h.project)
  })

  it('counts as set up with spoor.config.json or a .mcp.json spoor server, and never at home', () => {
    const h = home()
    expect(projectInitialized(h.project, { HOME: h.home })).toBe(false)
    writeFile(h.project, '.mcp.json', JSON.stringify({ mcpServers: { other: {} } }))
    expect(projectInitialized(h.project, { HOME: h.home })).toBe(false)
    writeFile(h.project, '.mcp.json', JSON.stringify({ mcpServers: { spoor: { url: 'x' } } }))
    expect(projectInitialized(h.project, { HOME: h.home })).toBe(true)
    writeFile(h.home, 'spoor.config.json', '{}')
    writeFile(h.home, '.mcp.json', JSON.stringify({ mcpServers: { spoor: { url: 'x' } } }))
    expect(projectInitialized(h.home, { HOME: h.home })).toBe(false)
  })
})

describe('a project that is not set up for Spoor', () => {
  it('hooks print nothing, call nothing and create no file, even with a token in the environment', async () => {
    const repo = makeRepo({ bare: true, git: true, files: { 'src/a.ts': 'a' } })
    const before = readdirSync(repo).sort()
    for (const name of ['session-start', 'stop', 'post-tool-use']) {
      const r = await run(['hook', name], {
        cwd: repo,
        env: localEnv(srv.url),
        stdin: JSON.stringify({
          cwd: repo,
          session_id: 's1',
          source: 'startup',
          tool_name: 'Write',
          tool_input: { file_path: join(repo, 'docs/adr/0001-x.md') },
        }),
      })
      expect(r).toMatchObject({ code: 0, out: '', err: '' })
    }
    expect(srv.requests).toEqual([])
    expect(readdirSync(repo).sort()).toEqual(before)
    expect(existsSync(join(repo, '.spoor'))).toBe(false)
  })

  it('hooks stay out of a project below a home directory that was once set up by mistake', async () => {
    const h = home()
    // what an old `spoor login` in ~ left behind
    writeFile(h.home, '.mcp.json', JSON.stringify({ mcpServers: { spoor: { url: 'x' } } }))
    writeFile(h.home, '.claude/settings.local.json', JSON.stringify({ env: localEnv(srv.url) }))
    for (const cwd of [h.project, h.home]) {
      const r = await run(['hook', 'session-start'], {
        cwd,
        env: { HOME: h.home },
        stdin: JSON.stringify({ cwd, session_id: 's1', source: 'startup' }),
      })
      expect(r).toMatchObject({ code: 0, out: '', err: '' })
    }
    expect(srv.requests).toEqual([])
    expect(existsSync(join(h.project, '.spoor'))).toBe(false)
    expect(existsSync(join(h.home, '.spoor'))).toBe(false)
  })

  it('commands other than login and init refuse, and write nothing', async () => {
    const repo = makeRepo({ bare: true })
    for (const argv of [['status'], ['whoami'], ['context'], ['docs', 'import'], ['memory', 'sync']]) {
      const r = await run(argv, { cwd: repo, env: localEnv(srv.url) })
      expect(r.code).toBe(1)
      expect(r.err).toContain('is not set up for Spoor (no spoor.config.json)')
      expect(r.out).toBe('')
    }
    expect(srv.requests).toEqual([])
    expect(existsSync(join(repo, '.spoor'))).toBe(false)
  })

  it('spoor init sets it up: writes spoor.config.json, and AGENTS.md inside the project', async () => {
    const h = home()
    srv.on('GET /p/acme/install.json', { body: installJson })
    const r = await run(['init', '--server', srv.url, '--project', 'acme'], {
      cwd: h.project,
      env: { HOME: h.home },
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('created spoor.config.json\n')
    expect(JSON.parse(readFileSync(join(h.project, 'spoor.config.json'), 'utf8'))).toEqual({
      server: srv.url,
      project: 'acme',
    })
    expect(existsSync(join(h.project, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(h.project, '.claude/settings.json'))).toBe(true)
    // nothing landed in the home directory
    expect(readdirSync(h.home).sort()).toEqual(['.claude', 'work'])
    expect(readdirSync(join(h.home, '.claude'))).toEqual([])
    // a second run keeps the marker
    const again = await run(['init', '--server', srv.url, '--project', 'acme'], {
      cwd: h.project,
      env: { HOME: h.home },
    })
    expect(again.out).toContain('unchanged spoor.config.json\n')
  })

  it('init and login refuse the home directory', async () => {
    const h = home()
    for (const argv of [
      ['init', '--server', srv.url, '--project', 'acme'],
      ['login', '--server', srv.url, '--project', 'acme'],
    ]) {
      const r = await run(argv, { cwd: h.home, env: { HOME: h.home } })
      expect(r.code).toBe(1)
      expect(r.err).toContain('is your home directory, not a project')
    }
    // also when Claude Code names it as the project directory
    const r = await run(['init', '--server', srv.url, '--project', 'acme'], {
      cwd: h.project,
      env: { HOME: h.home, CLAUDE_PROJECT_DIR: h.home },
    })
    expect(r.code).toBe(1)
    expect(srv.requests).toEqual([])
    expect(readdirSync(h.home).sort()).toEqual(['.claude', 'work'])
  })

  it('login --no-init refuses: without init the project would stay unmarked', async () => {
    const repo = makeRepo({ bare: true })
    const r = await run(
      ['login', '--server', srv.url, '--project', 'acme', '--token', 'spr_testtoken123', '--no-init'],
      {
        cwd: repo,
      },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('run spoor login without --no-init')
    expect(existsSync(join(repo, '.claude/settings.local.json'))).toBe(false)
  })
})

describe('the installed version', () => {
  it('is in the help text and in spoor status', async () => {
    const repo = makeRepo({ local: localEnv(srv.url) })
    expect((await run(['--help'], { cwd: repo })).out).toMatch(
      new RegExp(`^spoor ${VERSION.replace(/\./g, '\\.')}: `),
    )
    expect((await run(['status'], { cwd: repo })).out).toMatch(
      new RegExp(`^cli {6}spoor ${VERSION.replace(/\./g, '\\.')}\n`),
    )
  })
})
