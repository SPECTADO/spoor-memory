import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, findRepoRoot, resolveConfig } from './config.js'

function repo(opts: { local?: object; committed?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'spoor-cfg-'))
  mkdirSync(join(dir, '.claude'))
  if (opts.local) writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(opts.local))
  if (opts.committed) writeFileSync(join(dir, 'spoor.config.json'), JSON.stringify(opts.committed))
  return dir
}

describe('resolveConfig', () => {
  it('env beats settings.local.json beats spoor.config.json', () => {
    const dir = repo({
      local: { env: { SPOOR_URL: 'https://local.example', SPOOR_PROJECT: 'loc', SPOOR_TOKEN: 'spr_local' } },
      committed: { server: 'https://file.example', project: 'file' },
    })
    const c = resolveConfig({ cwd: dir, env: { SPOOR_URL: 'https://env.example/' } })
    expect(c.server).toEqual({ value: 'https://env.example', source: 'env' })
    expect(c.project).toEqual({ value: 'loc', source: 'settings.local.json' })
    expect(c.token).toEqual({ value: 'spr_local', source: 'settings.local.json' })
  })

  it('falls back to spoor.config.json for server and project only', () => {
    const dir = repo({ committed: { server: 'https://file.example', project: 'file', token: 'spr_nope' } })
    const c = resolveConfig({ cwd: dir, env: {} })
    expect(c.server?.source).toBe('spoor.config.json')
    expect(c.project?.value).toBe('file')
    expect(c.token).toBeUndefined()
  })

  it('flags override everything', () => {
    const dir = repo({ committed: { server: 'https://file.example' } })
    const c = resolveConfig({
      cwd: dir,
      env: { SPOOR_URL: 'https://env.example' },
      flags: { server: 'https://flag.example' },
    })
    expect(c.server?.source).toBe('flag')
  })

  it('rejects non-http server', () => {
    const dir = repo()
    expect(() => resolveConfig({ cwd: dir, env: { SPOOR_URL: 'ftp://x' } })).toThrow(ConfigError)
  })

  it('blocks a token when the server comes from the committed file', () => {
    const dir = repo({ committed: { server: 'https://file.example' } })
    const c = resolveConfig({ cwd: dir, env: { SPOOR_TOKEN: 'spr_x' } })
    expect(c.tokenBlocked).toMatch(/spoor login/)
  })

  it('does not block when url and token are stored together', () => {
    const dir = repo({ local: { env: { SPOOR_URL: 'https://a.example', SPOOR_TOKEN: 'spr_x' } } })
    expect(resolveConfig({ cwd: dir, env: {} }).tokenBlocked).toBeUndefined()
  })

  it('tolerates invalid json files', () => {
    const dir = repo()
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{nope')
    expect(resolveConfig({ cwd: dir, env: {} }).server).toBeUndefined()
  })
})

describe('findRepoRoot', () => {
  it('walks up to .claude and honours CLAUDE_PROJECT_DIR', () => {
    const dir = repo()
    const sub = join(dir, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(findRepoRoot(sub, {})).toBe(dir)
    expect(findRepoRoot(sub, { CLAUDE_PROJECT_DIR: '/x/y' })).toBe('/x/y')
  })
})
