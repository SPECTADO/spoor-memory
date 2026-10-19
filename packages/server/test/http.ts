/**
 * Drive the real Hono app in-process: `testApp()` builds it on the test database with stub ports, and
 * `Client` is a tiny browser (cookie jar, same-origin `Origin` header, JSON bodies).
 */
import { pino } from 'pino'
import { createApp, createAppModules } from '../src/app.js'
import { type Config, loadConfig } from '../src/config.js'
import type { DeviceServiceOptions } from '../src/modules/device/index.js'
import type { Ports } from '../src/ports.js'
import { newReadyState } from '../src/types.js'
import { testDb } from './db.js'
import { testDatabaseUrl } from './db-url.js'
import { stubPorts } from './ports.js'

export const TEST_ORIGIN = 'http://localhost:3000'

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    SPOOR_PUBLIC_URL: TEST_ORIGIN,
    NODE_ENV: 'test',
    ...env,
  })
}

export interface TestAppOptions {
  env?: Record<string, string>
  ports?: Ports
  /** Device module overrides (row cap, miss limiter). */
  device?: DeviceServiceOptions
  /** The version the install templates print (default: the server's VERSION). */
  version?: string
}

export function testApp(opts: TestAppOptions = {}) {
  const config = testConfig(opts.env)
  const state = newReadyState()
  Object.assign(state, { db: 'ok', migrations: 'ok', embedding: 'ok', ready: true })
  const ports = opts.ports ?? stubPorts()
  const logger = pino({ level: 'silent' })
  const modules = createAppModules(
    { config, logger, db: testDb(), ports },
    { device: opts.device, installVersion: opts.version },
  )
  const app = createApp({ config, logger, state, ports, modules })
  return { app, config, ports, modules }
}

type App = ReturnType<typeof testApp>['app']

export interface RequestOpts {
  body?: unknown
  /** Raw body (string) instead of JSON. */
  raw?: string
  headers?: Record<string, string>
  /** `null` sends no Origin header; default is the public origin. */
  origin?: string | null
}

export class Client {
  readonly cookies = new Map<string, string>()

  constructor(
    private readonly app: App,
    private readonly origin = TEST_ORIGIN,
  ) {}

  cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    const origin = opts.origin === undefined ? this.origin : opts.origin
    if (origin !== null) headers.origin = origin
    let body: string | undefined
    if (opts.raw !== undefined) body = opts.raw
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['content-type'] = 'application/json'
    }
    // like a real HTTP/1.1 client: a body always comes with Content-Length
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const cookie = this.cookieHeader()
    if (cookie) headers.cookie = cookie
    Object.assign(headers, opts.headers)
    const res = await this.app.request(`${TEST_ORIGIN}${path}`, { method, headers, body })
    for (const sc of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = sc.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return res
  }

  get = (path: string, opts?: RequestOpts) => this.request('GET', path, opts)
  post = (path: string, body?: unknown, opts?: RequestOpts) => this.request('POST', path, { ...opts, body })
  patch = (path: string, body?: unknown, opts?: RequestOpts) => this.request('PATCH', path, { ...opts, body })
  delete = (path: string, opts?: RequestOpts) => this.request('DELETE', path, opts)
}

/** A logged-in client (asserts the login succeeded). */
export async function loginAs(app: App, email: string, password: string): Promise<Client> {
  const client = new Client(app)
  const res = await client.post('/api/v1/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login as ${email} failed: ${res.status} ${await res.text()}`)
  return client
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}
