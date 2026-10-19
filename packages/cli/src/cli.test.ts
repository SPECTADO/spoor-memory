import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from './cli.js'
import { commands } from './commands.js'
import { USER_AGENT } from './ctx.js'

function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = ''
  let err = ''
  const cwd = mkdtempSync(join(tmpdir(), 'spoor-cli-main-'))
  return main(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env,
    cwd,
    readStdin: async () => '',
  }).then((code) => ({
    code,
    out,
    err,
  }))
}

describe('cli', () => {
  it('help lists every command', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    for (const c of commands) expect(r.out).toContain(c.path.join(' '))
  })

  it('every command has --help', async () => {
    for (const c of commands) {
      const r = await run([...c.path, '--help'])
      expect(r.code).toBe(0)
      expect(r.out + r.err).toContain(c.usage)
    }
  })

  it('unknown options are a usage error (exit 1)', async () => {
    const r = await run(['whoami', '--bogus'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('spoor whoami')
  })

  it('--version prints the version from package.json, which the User-Agent carries too (H7)', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect((await run(['--version'])).out).toBe(`${version}\n`)
    expect(USER_AGENT).toBe(`spoor-cli/${version}`)
  })

  it('hooks always exit 0, even with SPOOR_DRAFTING=1 or bad args', async () => {
    for (const env of [{}, { SPOOR_DRAFTING: '1' }, { SPOOR_DISABLE: '1' }]) {
      for (const argv of [
        ['hook', 'stop'],
        ['hook', 'session-start'],
        ['hook', 'post-tool-use'],
        ['hook', 'bogus'],
        ['hook'],
      ]) {
        expect((await run(argv, env)).code).toBe(0)
      }
    }
    expect((await run(['hook', 'stop'], { SPOOR_DRAFTING: '1' })).out).toBe('')
  })

  it('unknown command exits 1', async () => {
    expect((await run(['nope'])).code).toBe(1)
  })
})
