// Full restore pieces without a database (ADR-0039): the SQL around the pg_restore script, the tool arguments,
// and the maintenance gate. The real transaction runs in restore.integration.test.ts.
import type { RestoreStatusJson } from '@spoor/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../../types.js'
import { MaintenanceGate, RESTORE_STATUS_PATH } from './maintenance.js'
import { assertSafeArgs } from './pgtools.js'
import {
  RESTORE_PG_RESTORE_ARGS,
  RESTORE_PRELUDE,
  RESTORE_PSQL_ARGS,
  restoreEpilogue,
  sqlString,
} from './restore.js'

const NONCE = '6f1c1a52-6c8e-4a4f-9a51-0e7d8c2a9b10'
const USER = '0b0f3a7e-2a55-4c1f-8f61-3b7a2a9d4e21'

const epilogueInput = {
  nonce: NONCE,
  backupId: '20261120T030000Z-auto',
  backupCreatedAt: '2026-11-20T03:00:00.000Z',
  preRestoreBackupId: '20261126T120000Z-pre-restore',
  actor: { userId: USER, label: "o'brien@example.com" },
  credentials: {
    sharedProjectId: 'd3a0a6d4-3f0c-4f5e-9b7e-2b1c8d6e5f43',
    tokens: [
      { id: 'a3a0a6d4-3f0c-4f5e-9b7e-2b1c8d6e5f40', revoked_at: '2026-11-25T10:11:12.123456+00:00' },
      { id: 'b3a0a6d4-3f0c-4f5e-9b7e-2b1c8d6e5f41', revoked_at: null },
    ],
    users: [
      {
        id: USER,
        disabled_at: null,
        password_hash: "$scrypt$it's",
        password_changed_at: '2026-11-01T00:00:00+00:00',
      },
    ],
    invites: [
      { id: 'c3a0a6d4-3f0c-4f5e-9b7e-2b1c8d6e5f42', revoked_at: null, used_at: '2026-11-02T00:00:00Z' },
    ],
  },
}

describe('restore SQL', () => {
  it('quotes literals and refuses NUL', () => {
    expect(sqlString("it's")).toBe("'it''s'")
    expect(sqlString('back\\slash')).toBe("'back\\slash'")
    expect(() => sqlString('a\u0000b')).toThrow()
  })

  it('prelude opens the transaction, drops without CASCADE and never commits', () => {
    expect(RESTORE_PRELUDE).toMatch(
      /^SET standard_conforming_strings = on;\nBEGIN;\nSET lock_timeout = '10s';/,
    )
    expect(RESTORE_PRELUDE).not.toMatch(/CASCADE/i)
    expect(RESTORE_PRELUDE).not.toMatch(/COMMIT/i)
    expect(RESTORE_PRELUDE).not.toMatch(/DROP SCHEMA|DROP EXTENSION/i)
    // only what the current role owns, never an extension member
    expect(RESTORE_PRELUDE.match(/= me/g)?.length).toBe(7)
    expect(RESTORE_PRELUDE.match(/d\.deptype IN \('e'/g)?.length).toBe(7)
  })

  it('epilogue clears sessions, jobs, re-applies revocations, writes the nonce row and commits last', () => {
    const sql = restoreEpilogue(epilogueInput)
    expect(sql).toContain('TRUNCATE public.sessions, public.device_codes;')
    expect(sql).toContain("UPDATE public.job_locks SET locked_until = '-infinity', locked_by = NULL;")
    expect(sql).toContain("WHERE status = 'running'")
    expect(sql).toContain('2026-11-25T10:11:12.123456+00:00')
    // tokens deleted since the backup (not in the live list) are revoked; deleted users come back disabled
    expect(sql).toMatch(
      /UPDATE public\.tokens SET revoked_at = pg_catalog\.now\(\)\s+WHERE revoked_at IS NULL AND id NOT IN/,
    )
    expect(sql).toMatch(
      /UPDATE public\.users SET disabled_at = pg_catalog\.now\(\)\s+WHERE disabled_at IS NULL AND id NOT IN/,
    )
    expect(sql).toContain('SET password_hash = x.password_hash')
    expect(sql).toMatch(/UPDATE public\.invites SET revoked_at = pg_catalog\.now\(\)/)
    expect(sql).toContain("$scrypt$it''s")
    // the "deleted since" rules only for a backup of this instance; never for another one
    expect(sql.match(/EXISTS \(SELECT 1 FROM public\.projects WHERE id = 'd3a0a6d4/g)?.length).toBe(3)
    const other = restoreEpilogue({
      ...epilogueInput,
      credentials: { ...epilogueInput.credentials, sharedProjectId: null },
    })
    expect(other.match(/NOT IN \(SELECT x\.id FROM [^;]*\) AND false;/g)?.length).toBe(3)
    expect(sql).toContain("'o''brien@example.com'")
    expect(sql).toContain(`"nonce":"${NONCE}"`)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql.match(/COMMIT/g)?.length).toBe(1)
  })

  it('epilogue refuses malformed ids and timestamps', () => {
    expect(() => restoreEpilogue({ ...epilogueInput, nonce: "x'; DROP TABLE users; --" })).toThrow()
    expect(() => restoreEpilogue({ ...epilogueInput, actor: { userId: 'nope', label: 'a' } })).toThrow()
    expect(() =>
      restoreEpilogue({
        ...epilogueInput,
        credentials: { ...epilogueInput.credentials, tokens: [{ id: USER, revoked_at: "now()'); --" }] },
      }),
    ).toThrow()
    expect(() =>
      restoreEpilogue({
        ...epilogueInput,
        credentials: {
          ...epilogueInput.credentials,
          invites: [{ id: 'x', revoked_at: null, used_at: null }],
        },
      }),
    ).toThrow()
  })

  it('tool arguments obey the HARD RULE and psql never runs with -1', () => {
    expect(() => assertSafeArgs(RESTORE_PG_RESTORE_ARGS)).not.toThrow()
    expect(() => assertSafeArgs(RESTORE_PSQL_ARGS)).not.toThrow()
    expect(RESTORE_PSQL_ARGS).not.toContain('-1')
    expect(RESTORE_PSQL_ARGS).not.toContain('--single-transaction')
    expect(RESTORE_PG_RESTORE_ARGS).toEqual(expect.arrayContaining(['-n', 'public', 'drizzle']))
  })
})

const RUNNING: RestoreStatusJson = {
  state: 'running',
  phase: 'draining',
  backup_id: '20261120T030000Z-auto',
  pre_restore_backup_id: '20261126T120000Z-pre-restore',
  started_at: '2026-11-26T12:00:00.000Z',
  finished_at: null,
  error: 'secret detail',
  maintenance: true,
}

function gateApp(gate: MaintenanceGate, slow?: Promise<void>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'r1')
    await next()
  })
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.use(
    '*',
    gate.middleware(async () => RUNNING),
  )
  app.get('/api/v1/slow', async (c) => {
    await slow
    return c.json({ ok: true })
  })
  app.get(RESTORE_STATUS_PATH, (c) => c.json({ from: 'route' }))
  app.get('/api/v1/x', (c) => c.json({ ok: true }))
  app.get('/p/s/mcp', (c) => c.json({ ok: true }))
  app.get('/projects', (c) => c.text('spa'))
  return app
}

describe('maintenance gate', () => {
  it('passes everything through while off; restore-status goes to its route', async () => {
    const gate = new MaintenanceGate()
    const app = gateApp(gate)
    expect((await app.request('/api/v1/x')).status).toBe(200)
    expect(await (await app.request(RESTORE_STATUS_PATH)).json()).toEqual({ from: 'route' })
  })

  it('answers 503 maintenance everywhere but /healthz and a redacted restore-status while on', async () => {
    const gate = new MaintenanceGate()
    gate.enable()
    const app = gateApp(gate)
    const api = await app.request('/api/v1/x')
    expect(api.status).toBe(503)
    expect(api.headers.get('retry-after')).toBe('5')
    expect(await api.json()).toMatchObject({ error: 'maintenance' })
    const mcp = await app.request('/p/s/mcp')
    expect(mcp.status).toBe(503)
    expect(await mcp.json()).toMatchObject({ error: 'maintenance' })
    const spa = await app.request('/projects')
    expect(spa.status).toBe(503)
    expect(await spa.text()).toBe('maintenance')
    expect((await app.request('/healthz')).status).toBe(200)
    const st = await app.request(RESTORE_STATUS_PATH)
    expect(st.status).toBe(200)
    expect(st.headers.get('cache-control')).toBe('no-store')
    expect(await st.json()).toEqual({ ...RUNNING, backup_id: null, pre_restore_backup_id: null, error: null })
    // only GET
    expect((await app.request(RESTORE_STATUS_PATH, { method: 'POST' })).status).toBe(503)
    gate.disable()
    expect((await app.request('/api/v1/x')).status).toBe(200)
  })

  it('counts requests in flight; drain waits for them or times out', async () => {
    const gate = new MaintenanceGate()
    let finish!: () => void
    const slow = new Promise<void>((r) => {
      finish = r
    })
    const app = gateApp(gate, slow)
    const inflight = app.request('/api/v1/slow')
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.inFlight).toBe(1)
    gate.enable()
    expect(await gate.drain(20)).toBe(false)
    const drained = gate.drain(5000)
    finish()
    expect((await inflight).status).toBe(200)
    expect(await drained).toBe(true)
    expect(gate.inFlight).toBe(0)
    expect(await gate.drain(1)).toBe(true)
  })
})
