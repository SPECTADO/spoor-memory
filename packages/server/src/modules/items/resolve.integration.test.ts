// The project-scoped resolver (data-model.md section 0; review S2, deviation I42).
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createItem, createProject, createSharedProject } from '../../../test/factories.js'
import { testApp } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { items } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { ApiError } from '../../lib/errors.js'
import { type ResolveScope, resolveItemRef } from './resolve.js'
import type { Caller } from './writes.js'

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

describe('library pages (ADR-0014)', () => {
  const handles = async (p: Promise<unknown>) => {
    try {
      await p
      return null
    } catch (e) {
      expect((e as ApiError).code).toBe('ambiguous_id')
      return (e as ApiError).details?.handles
    }
  }

  it('L<n> in either case, S:L<n> from a project, plain L<n> inside _shared', async () => {
    const { read, inShared, acme, shared } = ctx
    const page = await createItem(db(), { projectId: acme.id, space: 'library', slug: 'guide' }) // number 4
    const sharedPage = await createItem(db(), { projectId: shared.id, space: 'library' }) // shared number 2
    for (const ref of ['L4', 'l4', ' L4 ', 'guide', page.id]) {
      expect(await resolveItemRef(db(), read, ref), ref).toMatchObject({
        id: page.id,
        handle: 'L4',
        space: 'library',
      })
    }
    expect(await resolveItemRef(db(), read, 'S:L2')).toMatchObject({
      id: sharedPage.id,
      handle: 'S:L2',
      shared: true,
    })
    expect(await resolveItemRef(db(), read, 'S:l2')).toMatchObject({ id: sharedPage.id })
    expect(await resolveItemRef(db(), inShared, 'L2')).toMatchObject({ id: sharedPage.id, handle: 'L2' })
    // the handle names the space: m4 and d4 are not the library page, L1 is not the memory
    expect(await code(resolveItemRef(db(), read, 'm4'))).toBe('not_found')
    expect(await code(resolveItemRef(db(), read, 'L1'))).toBe('not_found')
  })

  it('a library page and a doc with the same slug are ambiguous_id', async () => {
    const { read, acme, slug, doc } = ctx
    await slug(doc.id, 'guide')
    await createItem(db(), { projectId: acme.id, space: 'library', slug: 'guide' })
    expect(await handles(resolveItemRef(db(), read, 'guide'))).toEqual(['d2', 'L4'])
  })

  it('an own item with the slug of a _shared library page is ambiguous_id naming both', async () => {
    const { read, write, acme, shared, slug, doc, sharedMem } = ctx
    await slug(doc.id, 'graphics-guide')
    await createItem(db(), { projectId: shared.id, space: 'library', slug: 'graphics-guide' }) // S:L2
    expect(await handles(resolveItemRef(db(), read, 'graphics-guide'))).toEqual(['d2', 'S:L2'])
    // a write position never looks at _shared: the own doc
    expect((await resolveItemRef(db(), write, 'graphics-guide')).id).toBe(doc.id)
    // a _shared non-library twin still loses to the own item, as before
    await slug(sharedMem.id, 'session-store')
    expect((await resolveItemRef(db(), read, 'session-store')).projectId).toBe(acme.id)
    // an own library page with that slug is fine: no shadowing of a library page by a library page
    await slug(doc.id, 'other-doc')
    const own = await createItem(db(), { projectId: acme.id, space: 'library', slug: 'graphics-guide' })
    expect((await resolveItemRef(db(), read, 'graphics-guide')).id).toBe(own.id)
  })

  it('a write position on a library page is read_only_space for agents and editors without the right', async () => {
    const { acme } = ctx
    await createItem(db(), { projectId: acme.id, space: 'library', slug: 'guide' }) // L4
    const items = testApp({ ports: stubPorts() }).modules.items.items
    const ctxOf = (via: 'mcp' | 'cli' | 'web', rights?: Caller['rights']): Caller => ({
      ctx: {
        user: {
          id: '00000000-0000-4000-8000-000000000009',
          email: 'a@x',
          name: 'A',
          isAdmin: false,
          sharedEditor: false,
        },
        project: { id: acme.id, slug: 'acme', name: 'acme', kind: 'project' },
        role: 'editor',
        via: via === 'web' ? 'cookie' : 'bearer',
      } as AuthContext,
      via,
      project: { id: acme.id, slug: 'acme', kind: 'project' },
      rights,
    })
    for (const via of ['mcp', 'cli'] as const) {
      expect(await code(items.resolve(ctxOf(via), 'L4', 'write'))).toBe('read_only_space')
      expect(await code(items.resolve(ctxOf(via), 'L4', 'read'))).toBe('ok')
      expect(await code(items.resolve(ctxOf(via), 'm1', 'write'))).toBe('ok')
    }
    expect(await code(items.resolve(ctxOf('web', { item: true, library: false }), 'L4', 'write'))).toBe(
      'read_only_space',
    )
    expect(await code(items.resolve(ctxOf('web', { item: true, library: true }), 'L4', 'write'))).toBe('ok')
    // a viewer holding only the library flag: library pages yes, anything else forbidden
    expect(await code(items.resolve(ctxOf('web', { item: false, library: true }), 'L4', 'write'))).toBe('ok')
    expect(await code(items.resolve(ctxOf('web', { item: false, library: true }), 'm1', 'write'))).toBe(
      'forbidden',
    )
    expect(await code(items.resolve(ctxOf('web', { item: false, library: true }), 'm1', 'read'))).toBe('ok')
  })
})
