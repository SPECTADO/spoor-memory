import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { stubPorts } from '../test/ports.js'
import { createApp, createAppModules } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { createEmbeddingRegistry, LOCAL_TAG } from './modules/search/index.js'
import { newReadyState } from './types.js'

const logger = pino({ level: 'silent' })
const body = async (r: Response) =>
  (await r.json()) as Record<string, unknown> & { providers: Record<string, unknown>[] }

function setup(
  ready: boolean,
  env: Record<string, string> = {},
  pingDb: () => Promise<boolean> = async () => true,
) {
  const web = mkdtempSync(join(tmpdir(), 'spoor-web-'))
  mkdirSync(join(web, 'assets'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>spa</title>')
  writeFileSync(join(web, 'assets', 'a.js'), 'x')
  const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', SPOOR_WEB_DIR: web, ...env })
  const state = newReadyState()
  if (ready) Object.assign(state, { db: 'ok', migrations: 'ok', embedding: 'ok', ready: true })
  // the pool is lazy and these tests never reach the database
  const { db } = createDb(config.DATABASE_URL, 1)
  // the providers the runtime would bind (no model is loaded: `ready()` is never called here)
  const ports = stubPorts({ embeddings: createEmbeddingRegistry(config) })
  const modules = createAppModules({ config, logger, db, ports })
  return createApp({ config, logger, state, ports, modules, pingDb })
}

describe('/healthz after startup (phase-2 review)', () => {
  it('503 unhealthy with checks.db failed when the ping fails, cached for 5 s', async () => {
    let calls = 0
    let ok = false
    const app = setup(true, {}, async () => {
      calls++
      if (!ok) throw new Error('down')
      return true
    })
    const h = await app.request('/healthz')
    expect(h.status).toBe(503)
    expect(await h.json()).toMatchObject({ status: 'unhealthy', checks: { db: 'failed' } })
    ok = true
    expect((await app.request('/healthz')).status).toBe(503) // cached
    expect(calls).toBe(1)
  })

  it('shares one ping between concurrent probes and gives up after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let calls = 0
      const app = setup(true, {}, () => {
        calls++
        return new Promise<boolean>(() => {}) // a blackholed database
      })
      const probes = Promise.all([app.request('/healthz'), app.request('/healthz'), app.request('/healthz')])
      await vi.advanceTimersByTimeAsync(2100)
      const res = await probes
      expect(res.map((r) => r.status)).toEqual([503, 503, 503])
      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('app', () => {
  it('answers 503 starting until ready', async () => {
    const app = setup(false)
    const h = await app.request('/healthz')
    expect(h.status).toBe(503)
    expect((await body(h)).status).toBe('starting')
    const r = await app.request('/api/v1/instance')
    expect(r.status).toBe(503)
    expect(r.headers.get('retry-after')).toBe('5')
    expect((await body(r)).error).toBe('starting')
  })

  it('healthz and instance when ready, with a request id', async () => {
    const app = setup(true)
    const h = await app.request('/healthz')
    expect(h.status).toBe(200)
    expect(h.headers.get('x-request-id')).toBeTruthy()
    const i = await body(await app.request('/api/v1/instance'))
    expect(i).toMatchObject({ public_url: 'http://localhost:3000', default_provider: 'local' })
    expect(i.providers).toEqual([{ name: 'local', tag: LOCAL_TAG, dims: 384, remote: false }])
  })

  it('instance lists every provider the registry enables', async () => {
    const app = setup(true, {
      SPOOR_OPENAI_API_KEY: 'sk-test',
      SPOOR_VOYAGE_API_KEY: 'vk-test',
      SPOOR_VOYAGE_EMBED_MODEL: 'voyage-3.5',
      SPOOR_VOYAGE_EMBED_DIMS: '1024',
    })
    const i = await body(await app.request('/api/v1/instance'))
    expect(i.providers.map((p) => [p.name, p.remote])).toEqual([
      ['local', false],
      ['openai', true],
      ['voyage', true],
    ])
    expect(i.providers[1]).toMatchObject({ tag: 'openai:text-embedding-3-small/1536', dims: 1536 })
    expect(i.providers[2]).toMatchObject({ tag: 'voyage:voyage-3.5/1024', dims: 1024 })
  })

  it('the MCP endpoint is mounted with its own bearer auth (401 + WWW-Authenticate before any DB access)', async () => {
    const res = await setup(true).request('/p/acme/mcp', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    expect(await res.json()).toMatchObject({ error: 'invalid_token', request_id: expect.any(String) })
  })

  it.each([
    ['GET', '/api/v1/projects/acme/dashboard', 401],
    ['GET', '/api/v1/device/lookup', 401],
    ['GET', '/p/acme/device/code', 404], // wrong method
    ['POST', '/p/acme/install.md', 404],
  ])('%s %s is %i (review SC3)', async (method, path, status) => {
    const res = await setup(true).request(path, { method })
    expect(res.status).toBe(status)
  })

  it('the bearer API refuses a request without a token before any route (401 + WWW-Authenticate)', async () => {
    const res = await setup(true).request('/p/acme/api/push', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="spoor"')
    expect(await res.json()).toMatchObject({
      error: 'invalid_token',
      hint: expect.stringContaining('install.md'),
    })
  })

  it('serves the SPA with history fallback but never swallows unknown API paths', async () => {
    const app = setup(true)
    expect(await (await app.request('/assets/a.js')).text()).toBe('x')
    const spa = await app.request('/projects/acme/memories')
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('<title>spa</title>')
    const missing = await app.request('/p/nothing')
    expect(missing.status).toBe(404)
  })
})
