/**
 * Test helpers: a declarative fetch mock for `/api/v1` and an app renderer (memory router + query client +
 * toasts), so page tests exercise the real routes, guards and hooks.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'
import type { MeResponse } from '../api/types'
import { createQueryClient } from '../queryClient'
import { createTestRouter } from '../router'
import { ToastProvider } from '../ui'

export const json = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const apiError = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json(status, { error, request_id: 'req-1', ...extra })

export interface MockRequest {
  method: string
  path: string
  url: URL
  body: unknown
  init: RequestInit
}

/** A reply: a Response, a function of the request, or `[status, body]`. */
export type Reply = Response | [number, unknown?] | ((req: MockRequest) => Response | Promise<Response>)

/**
 * Stub `fetch`. Keys are `METHOD /path` (path without the query string, e.g. `GET /api/v1/me`). An array
 * value is used in order (the last one repeats). Unknown routes answer 404 `not_found`.
 */
export function mockApi(routes: Record<string, Reply | Reply[]>) {
  const calls: MockRequest[] = []
  const counters = new Map<string, number>()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init.method ?? 'GET').toUpperCase()
    let body: unknown = init.body
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const req: MockRequest = { method, path: url.pathname, url, body, init }
    calls.push(req)
    const key = `${method} ${url.pathname}`
    let reply = routes[key]
    if (Array.isArray(reply) && (reply.length === 0 || typeof reply[0] !== 'number')) {
      const list = reply as Reply[]
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      reply = list[Math.min(n, list.length - 1)]
    }
    if (reply === undefined) return apiError(404, 'not_found')
    if (reply instanceof Response) return reply.clone()
    if (typeof reply === 'function') return reply(req)
    const [status, b] = reply as [number, unknown?]
    return json(status, b)
  })
  vi.stubGlobal('fetch', fetchMock)
  const find = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path)
  return { calls, fetchMock, find }
}

export function meFixture(
  over: Partial<MeResponse['user']> = {},
  memberships: MeResponse['memberships'] = [],
): MeResponse {
  return {
    user: { id: 'u1', email: 'ann@example.com', name: 'Ann', is_admin: false, shared_editor: false, ...over },
    memberships,
  }
}

export function renderApp(path: string) {
  const qc = createQueryClient()
  const router = createTestRouter(qc, [path])
  const utils = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  )
  return { ...utils, router, qc }
}

/** Render a component with only the providers (no routes). */
export function renderWithProviders(ui: ReactNode) {
  const qc = createQueryClient()
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>,
    ),
  }
}

/** Render a component inside a memory router (for components that render links). */
export function renderInRouter(ui: ReactNode, path = '/') {
  const qc = createQueryClient()
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return {
    qc,
    router,
    ...render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  }
}
