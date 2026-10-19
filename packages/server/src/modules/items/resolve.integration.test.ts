// The project-scoped resolver (data-model.md section 0; review S2, deviation I42).
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createItem, createProject, createSharedProject } from '../../../test/factories.js'
import { items } from '../../db/schema.js'
import { ApiError } from '../../lib/errors.js'
import { type ResolveScope, resolveItemRef } from './resolve.js'

const db = () => testDb()

let ctx: Awaited<ReturnType<typeof seed>>

async function seed() {
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const other = await createProject(db(), { slug: 'other' })
  const mem = await createItem(db(), { projectId: acme.id, title: 'Session store' }) // m1
  const doc = await createItem(db(), { projectId: acme.id, space: 'docs' }) // d2
  const adr = await createItem(db(), { projectId: acme.id, space: 'decisions' }) // number 3, ADR-0001
  const sharedMem = await createItem(db(), { projectId: shared.id }) // S:m1
  const foreign = await createItem(db(), { projectId: other.id }) // other's m1
  const slug = async (id: string, s: string) => db().update(items).set({ slug: s }).where(eq(items.id, id))
  await slug(mem.id, 'session-store')
  await slug(sharedMem.id, 'style-guide')
  await slug(foreign.id, 'secret-plan')
  const read: ResolveScope = { projectId: acme.id, projectIsShared: false, mode: 'read' }
  const write: ResolveScope = { ...read, mode: 'write' }
  const inShared: ResolveScope = { projectId: shared.id, projectIsShared: true, mode: 'write' }
  return { shared, acme, other, mem, doc, adr, sharedMem, foreign, read, write, inShared, slug }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError) return e.code
    throw e
  }
}

beforeEach(async () => {
  ctx = await seed()
})

describe('resolveItemRef', () => {
  it('resolves handles inside the caller’s project', async () => {
    const { read, mem, doc, adr } = ctx
    expect(await resolveItemRef(db(), read, 'm1')).toMatchObject({ id: mem.id, handle: 'm1', shared: false })
    expect(await resolveItemRef(db(), read, 'd2')).toMatchObject({ id: doc.id, handle: 'd2', space: 'docs' })
    for (const ref of ['ADR-0001', 'adr-1', 'ADR-1', ' ADR-0001 ']) {
      expect((await resolveItemRef(db(), read, ref)).id).toBe(adr.id)
    }
    expect(await resolveItemRef(db(), read, 'ADR-0001')).toMatchObject({ handle: 'ADR-0001', adrNumber: 1 })
    // a handle names number AND space: m2 is a doc, d1 is a memory
    expect(await code(resolveItemRef(db(), read, 'm2'))).toBe('not_found')
    expect(await code(resolveItemRef(db(), read, 'd1'))).toBe('not_found')
    expect(await code(resolveItemRef(db(), read, 'm99'))).toBe('not_found')
  })

  it('uuid and slug: own project, plus _shared for reads only', async () => {
    const { read, write, mem, sharedMem } = ctx
    expect((await resolveItemRef(db(), read, mem.id)).id).toBe(mem.id)
    expect((await resolveItemRef(db(), read, mem.id.toUpperCase())).id).toBe(mem.id)
    expect((await resolveItemRef(db(), read, 'session-store')).id).toBe(mem.id)
    expect(await resolveItemRef(db(), read, sharedMem.id)).toMatchObject({ shared: true, handle: 'S:m1' })
    expect((await resolveItemRef(db(), read, 'style-guide')).id).toBe(sharedMem.id)
    expect(await code(resolveItemRef(db(), write, sharedMem.id))).toBe('not_found')
    expect(await code(resolveItemRef(db(), write, 'style-guide'))).toBe('not_found')
  })

  it('S: prefix selects the shared project; in a write position it is read_only_space', async () => {
    const { read, write, sharedMem } = ctx
    expect((await resolveItemRef(db(), read, 'S:m1')).id).toBe(sharedMem.id)
    expect((await resolveItemRef(db(), read, 'S:style-guide')).id).toBe(sharedMem.id)
    expect((await resolveItemRef(db(), read, `S:${sharedMem.id}`)).id).toBe(sharedMem.id)
    expect(await code(resolveItemRef(db(), read, 'S:session-store'))).toBe('not_found')
    expect(await code(resolveItemRef(db(), write, 'S:m1'))).toBe('read_only_space')
    expect(await code(resolveItemRef(db(), read, 's:m1'))).toBe('not_found')
    expect(await code(resolveItemRef(db(), read, 'S:S:m1'))).toBe('not_found')
  })

  it('never reaches another project: uuid, slug and handle are not_found', async () => {
    const { read, foreign } = ctx
    expect(await code(resolveItemRef(db(), read, foreign.id))).toBe('not_found')
    expect(await code(resolveItemRef(db(), read, 'secret-plan'))).toBe('not_found')
    // acme's own m1 wins; the other project's m1 is never considered
    expect((await resolveItemRef(db(), read, 'm1')).projectId).toBe(ctx.acme.id)
  })

  it('inside _shared: handles carry no prefix and both scopes are _shared', async () => {
    const { inShared, sharedMem, mem } = ctx
    expect(await resolveItemRef(db(), inShared, 'm1')).toMatchObject({
      id: sharedMem.id,
      handle: 'm1',
      shared: true,
    })
    expect((await resolveItemRef(db(), inShared, 'S:m1')).id).toBe(sharedMem.id)
    expect(await code(resolveItemRef(db(), { ...inShared, mode: 'read' }, mem.id))).toBe('not_found')
  })

  it('a slug used in two spaces is ambiguous_id with the handles', async () => {
    const { read, doc, slug } = ctx
    await slug(doc.id, 'session-store')
    try {
      await resolveItemRef(db(), read, 'session-store')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe('ambiguous_id')
      expect((e as ApiError).details).toEqual({ handles: ['m1', 'd2'] })
    }
  })

  it('a project slug match beats a shared one', async () => {
    const { read, mem, slug } = ctx
    await slug(mem.id, 'style-guide')
    expect((await resolveItemRef(db(), read, 'style-guide')).id).toBe(mem.id)
  })

  it('rejects junk without querying anything odd', async () => {
    const { read } = ctx
    for (const ref of ['', '   ', 'Not A Slug', 'x'.repeat(201), "a'; DROP TABLE items; --", '%', 'ADR-'])
      expect(await code(resolveItemRef(db(), read, ref)), ref).toBe('not_found')
  })
})
