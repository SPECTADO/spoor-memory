// Startup step 6: the bootstrap instance admin (auth-and-security.md section 2, deployment.md section 4).
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createUser } from '../../../test/factories.js'
import { loginAs, testApp } from '../../../test/http.js'
import { StartupError } from '../../db/migrate.js'
import { auditLog, users } from '../../db/schema.js'
import { bootstrapAdmin } from './bootstrap.js'

const env = (o: { email?: string; password?: string; name?: string }) => ({
  SPOOR_ADMIN_EMAIL: o.email,
  SPOOR_ADMIN_PASSWORD: o.password,
  SPOOR_ADMIN_NAME: o.name ?? 'Admin',
})

describe('bootstrapAdmin', () => {
  it('exits with a clear error on an empty database without SPOOR_ADMIN_*', async () => {
    await expect(bootstrapAdmin(testDb(), env({}))).rejects.toThrow(StartupError)
    await expect(bootstrapAdmin(testDb(), env({}))).rejects.toThrow(
      /SPOOR_ADMIN_EMAIL and SPOOR_ADMIN_PASSWORD/,
    )
    await expect(bootstrapAdmin(testDb(), env({ email: 'a@example.com' }))).rejects.toThrow(
      /SPOOR_ADMIN_PASSWORD/,
    )
    await expect(
      bootstrapAdmin(testDb(), env({ email: 'nope', password: 'long enough pw' })),
    ).rejects.toThrow(/SPOOR_ADMIN_EMAIL is not a valid/)
    expect(await testDb().select().from(users)).toHaveLength(0)
  })

  it('creates the instance admin once, who can log in; later runs ignore the variables', async () => {
    const r = await bootstrapAdmin(
      testDb(),
      env({ email: ' Root@Example.com ', password: 'bootstrap secret', name: 'Root‮' }),
    )
    expect(r).toMatchObject({ created: true, email: 'root@example.com' })
    const [u] = await testDb().select().from(users)
    expect(u).toMatchObject({ email: 'root@example.com', name: 'Root', isAdmin: true, sharedEditor: false })
    expect(u?.passwordHash.startsWith('scrypt$17$8$1$')).toBe(true)
    const [audit] = await testDb().select().from(auditLog)
    expect(audit).toMatchObject({ action: 'user.create', via: 'system', actorLabel: 'system' })

    const { app } = testApp()
    await loginAs(app, 'root@example.com', 'bootstrap secret')

    expect(await bootstrapAdmin(testDb(), env({}))).toEqual({ created: false })
    expect(
      await bootstrapAdmin(testDb(), env({ email: 'other@example.com', password: 'another secret' })),
    ).toEqual({
      created: false,
    })
    expect(await testDb().select().from(users)).toHaveLength(1)
  })

  it('does nothing when any user exists', async () => {
    await createUser(testDb())
    expect(await bootstrapAdmin(testDb(), env({}))).toEqual({ created: false })
  })

  it('concurrent startups create exactly one admin', async () => {
    const e = env({ email: 'root@example.com', password: 'bootstrap secret' })
    const results = await Promise.all([bootstrapAdmin(testDb(), e), bootstrapAdmin(testDb(), e)])
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await testDb().select().from(users)).toHaveLength(1)
  })
})
