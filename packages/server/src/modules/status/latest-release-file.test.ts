/**
 * deploy/latest-release.mjs (the release workflow's writer) against the server's reader schema, plus the file that
 * is on main: whatever the workflow writes, every server must accept, and nothing half-published is written.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestReleaseFile } from './update-check.js'

interface Writer {
  latestRelease(o: {
    version: string
    npm: string
    image: string
    releasedAt?: string
    previous?: unknown
  }): { file?: Record<string, unknown>; skip?: string }
  validate(file: unknown): string[]
  main(argv: string[], log?: (m: string) => void): number
}

const DEPLOY = new URL('../../../../../deploy/', import.meta.url)
const writer = (await import(new URL('latest-release.mjs', DEPLOY).href)) as Writer
const AT = '2026-11-12T10:00:00.000Z'

describe('deploy/latest-release.mjs', () => {
  it('writes a file the server accepts when npm and the image carry the version', () => {
    const r = writer.latestRelease({ version: '0.7.0', npm: '0.7.0', image: '0.7.0', releasedAt: AT })
    expect(r.file).toEqual({
      schema: 1,
      version: '0.7.0',
      npm: '0.7.0',
      image: '0.7.0',
      released_at: AT,
      url: 'https://github.com/SPECTADO/spoor-memory/releases/tag/v0.7.0',
    })
    expect(latestReleaseFile.safeParse(r.file).success).toBe(true)
  })

  it('writes nothing for a pre-release or a half-published release', () => {
    for (const o of [
      { version: '0.8.0-rc.1', npm: '0.8.0-rc.1', image: '0.8.0-rc.1' },
      { version: '0.7.0', npm: '0.6.1', image: '0.7.0' },
      { version: '0.7.0', npm: '0.7.0', image: '' },
      { version: '0.7.0', npm: '', image: '0.7.0' },
      { version: '0.0.0', npm: '0.0.0', image: '0.0.0' },
    ]) {
      const r = writer.latestRelease(o)
      expect(r.file, JSON.stringify(o)).toBeUndefined()
      expect(r.skip).toBeTruthy()
    }
  })

  it('a re-run for the same version changes nothing; a new version replaces the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoor-latest-'))
    const out = join(dir, 'latest-release.json')
    const log: string[] = []
    const run = (v: string, at: string) =>
      writer.main(['--version', `v${v}`, '--npm', v, '--image', v, '--released-at', at, '--out', out], (m) =>
        log.push(m),
      )
    expect(run('0.7.0', AT)).toBe(0)
    const first = readFileSync(out, 'utf8')
    expect(run('0.7.0', '2026-12-01T00:00:00Z')).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(first)
    expect(log.at(-1)).toBe('latest-release.json already says 0.7.0')
    expect(run('0.7.1', '2026-12-01T00:00:00Z')).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
      version: '0.7.1',
      released_at: '2026-12-01T00:00:00Z',
    })
    // npm behind: the file stays on 0.7.1
    expect(
      writer.main(['--version', '0.7.2', '--npm', '0.7.1', '--image', '0.7.2', '--out', out], () => {}),
    ).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe('0.7.1')
    // a broken file is replaced, not trusted
    writeFileSync(out, '{"schema":1,"version":"0.7.1"}')
    expect(run('0.7.1', AT)).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).released_at).toBe(AT)
    expect(writer.main([], () => {})).toBe(1)
  })

  it('validate() and the server schema agree on bad files', () => {
    const good = writer.latestRelease({ version: '0.7.0', npm: '0.7.0', image: '0.7.0', releasedAt: AT })
      .file as Record<string, unknown>
    for (const bad of [
      { ...good, schema: 2 },
      { ...good, npm: '0.6.1' },
      { ...good, url: 'https://example.com/x' },
      { ...good, version: '0.7.0-rc.1' },
      [],
    ]) {
      expect(writer.validate(bad).length, JSON.stringify(bad)).toBeGreaterThan(0)
      expect(latestReleaseFile.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('the file on main is valid and names a published release', () => {
    const file = JSON.parse(readFileSync(new URL('latest-release.json', DEPLOY), 'utf8'))
    expect(writer.validate(file)).toEqual([])
    expect(latestReleaseFile.parse(file).version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
