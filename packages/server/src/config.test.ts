import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_UPDATE_URL, loadConfig } from './config.js'

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

  it('ollama is off without a URL, defaults to embeddinggemma/768, and cannot be the default without one', () => {
    expect(loadConfig(base).SPOOR_OLLAMA_URL).toBeUndefined()
    const c = loadConfig({
      ...base,
      SPOOR_OLLAMA_URL: 'http://ollama:11434',
      SPOOR_EMBEDDING_DEFAULT: 'ollama',
    })
    expect(c).toMatchObject({ SPOOR_OLLAMA_EMBED_MODEL: 'embeddinggemma', SPOOR_OLLAMA_EMBED_DIMS: 768 })
    expect(() => loadConfig({ ...base, SPOOR_EMBEDDING_DEFAULT: 'ollama' })).toThrow(
      /ollama needs SPOOR_OLLAMA_URL/,
    )
    expect(() => loadConfig({ ...base, SPOOR_OLLAMA_URL: 'ollama:11434' })).toThrow(/SPOOR_OLLAMA_URL/)
    expect(() =>
      loadConfig({ ...base, SPOOR_OLLAMA_URL: 'http://o', SPOOR_OLLAMA_EMBED_MODEL: "x'; drop" }),
    ).toThrow(/SPOOR_OLLAMA_EMBED_MODEL/)
  })

  it('SPOOR_PUSH_CONCURRENCY: 3 by default, 1..64, an empty string is unset', () => {
    expect(loadConfig(base).SPOOR_PUSH_CONCURRENCY).toBe(3)
    expect(loadConfig({ ...base, SPOOR_PUSH_CONCURRENCY: '1' }).SPOOR_PUSH_CONCURRENCY).toBe(1)
    expect(loadConfig({ ...base, SPOOR_PUSH_CONCURRENCY: '' }).SPOOR_PUSH_CONCURRENCY).toBe(3)
    expect(() => loadConfig({ ...base, SPOOR_PUSH_CONCURRENCY: '0' })).toThrow(/SPOOR_PUSH_CONCURRENCY/)
    expect(() => loadConfig({ ...base, SPOOR_PUSH_CONCURRENCY: '65' })).toThrow(/SPOOR_PUSH_CONCURRENCY/)
  })

  it('SPOOR_UPDATE_CHECK: on by default with the GitHub file, off switches it off, a bad URL is a problem', () => {
    const c = loadConfig(base)
    expect(c.SPOOR_UPDATE_CHECK).toBe('on')
    expect(c.SPOOR_UPDATE_URL).toBe(DEFAULT_UPDATE_URL)
    expect(DEFAULT_UPDATE_URL).toBe(
      'https://raw.githubusercontent.com/SPECTADO/spoor-memory/main/deploy/latest-release.json',
    )
    expect(loadConfig({ ...base, SPOOR_UPDATE_CHECK: 'off' }).SPOOR_UPDATE_CHECK).toBe('off')
    expect(loadConfig({ ...base, SPOOR_UPDATE_CHECK: '', SPOOR_UPDATE_URL: '' }).SPOOR_UPDATE_CHECK).toBe(
      'on',
    )
    const mirror = 'https://mirror.example/latest-release.json'
    expect(loadConfig({ ...base, SPOOR_UPDATE_URL: mirror }).SPOOR_UPDATE_URL).toBe(mirror)
    expect(() => loadConfig({ ...base, SPOOR_UPDATE_CHECK: 'yes' })).toThrow(/SPOOR_UPDATE_CHECK/)
    expect(() => loadConfig({ ...base, SPOOR_UPDATE_URL: 'ftp://x/y' })).toThrow(/SPOOR_UPDATE_URL/)
  })

  it('rejects a public URL with a path', () => {
    expect(() => loadConfig({ ...base, SPOOR_PUBLIC_URL: 'https://x.example/app' })).toThrow(
      /SPOOR_PUBLIC_URL/,
    )
    expect(loadConfig({ ...base, SPOOR_PUBLIC_URL: 'https://x.example' }).cookieSecure).toBe(true)
  })
})
