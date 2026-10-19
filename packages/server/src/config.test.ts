import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.js'

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/spoor' }

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base)
    expect(c.SPOOR_PORT).toBe(3000)
    expect(c.SPOOR_JOBS).toBe('on')
    expect(c.SPOOR_EMBEDDING_DEFAULT).toBe('local')
    expect(c.publicOrigin).toBe('http://localhost:3000')
    expect(c.cookieSecure).toBe(false)
    expect(c.trustedProxies).toBeNull()
  })

  it('SPOOR_TRUST_PROXY: off by default, parsed when set, an invalid entry is a config problem', () => {
    expect(loadConfig({ ...base, SPOOR_TRUST_PROXY: '' }).trustedProxies).toBeNull()
    expect(loadConfig({ ...base, SPOOR_TRUST_PROXY: 'private' }).trustedProxies?.has('172.18.0.2')).toBe(true)
    expect(() => loadConfig({ ...base, SPOOR_TRUST_PROXY: 'everyone' })).toThrow(/SPOOR_TRUST_PROXY/)
  })

  it('treats empty strings as unset (compose passes empty defaults)', () => {
    const c = loadConfig({
      ...base,
      SPOOR_OPENAI_API_KEY: '',
      SPOOR_OPENAI_EMBED_DIMS: '',
      SPOOR_ADMIN_EMAIL: '',
    })
    expect(c.SPOOR_OPENAI_API_KEY).toBeUndefined()
    expect(c.SPOOR_OPENAI_EMBED_DIMS).toBe(1536)
  })

  it('reads secrets from _FILE and trims the newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spoor-cfg-'))
    const f = join(dir, 'db')
    writeFileSync(f, 'postgres://a:b@db:5432/spoor\n')
    expect(loadConfig({ DATABASE_URL_FILE: f }).DATABASE_URL).toBe('postgres://a:b@db:5432/spoor')
  })

  it('rejects both NAME and NAME_FILE, and lists all problems without secret values', () => {
    try {
      loadConfig({
        ...base,
        DATABASE_URL_FILE: '/nonexistent',
        SPOOR_PORT: 'abc',
        SPOOR_ADMIN_PASSWORD: 'short',
      })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const msg = (e as ConfigError).message
      expect(msg).toContain('DATABASE_URL and DATABASE_URL_FILE are both set')
      expect(msg).toContain('SPOOR_PORT')
      expect(msg).toContain('SPOOR_ADMIN_PASSWORD')
      expect(msg).not.toContain('short')
    }
  })

  it('requires voyage model and dims when the key is set', () => {
    expect(() => loadConfig({ ...base, SPOOR_VOYAGE_API_KEY: 'k' })).toThrow(/SPOOR_VOYAGE_EMBED_MODEL/)
  })

  it('rejects a public URL with a path', () => {
    expect(() => loadConfig({ ...base, SPOOR_PUBLIC_URL: 'https://x.example/app' })).toThrow(
      /SPOOR_PUBLIC_URL/,
    )
    expect(loadConfig({ ...base, SPOOR_PUBLIC_URL: 'https://x.example' }).cookieSecure).toBe(true)
  })
})
