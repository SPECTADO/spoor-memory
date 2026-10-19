import { describe, expect, it, vi } from 'vitest'
import { json, mockApi } from '../test/utils'
import { ApiError, api, apiUrl, toQueryString } from './client'
import * as E from './endpoints'

describe('toQueryString', () => {
  it('skips empty values and repeats arrays', () => {
    expect(
      toQueryString({ q: 'a b', tag: ['x', 'y'], none: undefined, nil: null, empty: '', n: 0, f: false }),
    ).toBe('?q=a+b&tag=x&tag=y&n=0&f=false')
    expect(toQueryString({})).toBe('')
  })
})

describe('apiUrl', () => {
  it('refuses absolute and protocol-relative paths', () => {
    expect(() => apiUrl('https://evil.example/x')).toThrow()
    expect(() => apiUrl('//evil.example/x')).toThrow()
    expect(apiUrl('/me')).toBe('/api/v1/me')
  })
})

describe('api()', () => {
  it('sends JSON with credentials same-origin and parses the flat error body', async () => {
    const m = mockApi({
      'POST /api/v1/projects/acme/items/m1/edges': [
        409,
        {
          error: 'revision_conflict',
          message: 'm1 is at r7',
          hint: 're-read',
          details: { current_revision: 7 },
          request_id: 'r9',
        },
      ],
    })
    const err = (await api('/projects/acme/items/m1/edges', { body: { kind: 'supports', to: 'm2' } }).catch(
      (e) => e,
    )) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 409,
      code: 'revision_conflict',
      hint: 're-read',
      requestId: 'r9',
      message: 'm1 is at r7',
    })
    expect(err.details).toEqual({ current_revision: 7 })
    const call = m.calls[0]
    expect(call?.init.credentials).toBe('same-origin')
    expect((call?.init.headers as Record<string, string> | undefined)?.['Content-Type']).toBe(
      'application/json',
    )
    expect(call?.body).toEqual({ kind: 'supports', to: 'm2' })
  })

  it('exposes invalid_input issues', async () => {
    mockApi({
      'POST /api/v1/projects': [
        400,
        { error: 'invalid_input', request_id: 'r', details: { issues: [{ path: 'slug', message: 'bad' }] } },
      ],
    })
    const err = (await E.createProject({ slug: 'X', name: 'x' }).catch((e) => e)) as ApiError
    expect(err.issues).toEqual([{ path: 'slug', message: 'bad' }])
  })

  it('returns undefined for 204 and sends bodyless POSTs without a content type', async () => {
    const m = mockApi({
      'POST /api/v1/auth/logout': [204],
      'POST /api/v1/projects/acme/items/m1/pin': [200, { item: { handle: 'm1' } }],
    })
    await expect(E.logout()).resolves.toBeUndefined()
    await E.itemAction('acme', 'm1', 'pin')
    const pin = m.find('POST', '/api/v1/projects/acme/items/m1/pin')[0]
    expect(pin?.init.body).toBeUndefined()
    expect((pin?.init.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined()
  })

  it('turns a network failure into ApiError status 0 / code network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const err = (await E.getMe().catch((e) => e)) as ApiError
    expect(err.status).toBe(0)
    expect(err.code).toBe('network')
  })

  it('posts imports as multipart without a hand-set content type', async () => {
    const m = mockApi({ 'POST /api/v1/projects/acme/import': () => json(200, { project: { slug: 'acme' } }) })
    await E.importIntoProject('acme', new File(['zip'], 'a.zip'), true)
    const c = m.calls[0]
    expect(c?.init.body).toBeInstanceOf(FormData)
    expect((c?.init.body as FormData | undefined)?.get('remap_ids')).toBe('true')
    expect((c?.init.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined()
  })
})

describe('endpoints', () => {
  it('encodes path segments and builds list queries', async () => {
    const m = mockApi({
      'GET /api/v1/projects/a%2Fb/spaces/memories/items': [200, { items: [], next_cursor: null }],
    })
    await E.listItems('a/b', 'memories', {
      type: ['fact', 'procedure'],
      lifecycle: ['all'],
      tag: ['x', 'y'],
      pinned: true,
    })
    expect(m.calls[0]?.url.search).toBe('?type=fact%2Cprocedure&lifecycle=all&tag=x&tag=y&pinned=true')
  })

  it('confirms deletes with the handle / slug / email', async () => {
    const m = mockApi({
      'DELETE /api/v1/projects/acme/items/ADR-0007': [204],
      'DELETE /api/v1/projects/acme': [204],
      'DELETE /api/v1/users/u1': [204],
    })
    await E.deleteItem('acme', 'ADR-0007')
    await E.deleteProject('acme')
    await E.deleteUser('u1', 'ann@example.com')
    expect(m.calls.map((c) => c.url.search)).toEqual([
      '?confirm=ADR-0007',
      '?confirm=acme',
      '?confirm=ann%40example.com',
    ])
  })

  it('builds the export link without fetching', () => {
    expect(E.exportUrl('acme')).toBe('/api/v1/projects/acme/export')
    expect(E.exportUrl('acme', false)).toBe('/api/v1/projects/acme/export?history=0')
  })
})
