/**
 * The in-memory MCP session table (docs/design/mcp.md section 3): one `McpServer` + transport per session,
 * bound to the token that created it; idle TTL 30 min (swept every 5 min, `mcp-session-sweep`), at most 20
 * sessions per token and 2000 in total, the least recently used one evicted. A restart empties it; clients
 * get 404 and re-initialize.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { ProjectRole } from '@spoor/shared'

export const SESSION_IDLE_TTL_MS = 30 * 60_000
export const SESSION_SWEEP_MS = 5 * 60_000
export const SESSIONS_PER_TOKEN = 20
export const SESSIONS_TOTAL = 2000

export interface McpSession {
  id: string
  mcp: Pick<McpServer, 'close'>
  transport: Pick<WebStandardStreamableHTTPServerTransport, 'handleRequest'>
  tokenId: string
  projectId: string
  role: ProjectRole | null
  /** `name/version` from initialize, or `ua:<User-Agent>`; null until known. */
  client: string | null
  lastSeenAt: number
}

export interface SessionStoreOptions {
  ttlMs?: number
  perToken?: number
  total?: number
  now?: () => number
}

export class SessionStore {
  /** Insertion order = least recently used first (a touch re-inserts). */
  readonly #map = new Map<string, McpSession>()
  readonly ttlMs: number
  readonly perToken: number
  readonly total: number
  readonly now: () => number

  constructor(opts: SessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? SESSION_IDLE_TTL_MS
    this.perToken = opts.perToken ?? SESSIONS_PER_TOKEN
    this.total = opts.total ?? SESSIONS_TOTAL
    this.now = opts.now ?? Date.now
  }

  get size(): number {
    return this.#map.size
  }

  /** The live session `id`, or undefined (unknown or idle past the TTL, which closes it). */
  get(id: string): McpSession | undefined {
    const s = this.#map.get(id)
    if (!s) return undefined
    if (this.now() - s.lastSeenAt > this.ttlMs) {
      this.remove(id)
      return undefined
    }
    return s
  }

  touch(s: McpSession): void {
    s.lastSeenAt = this.now()
    this.#map.delete(s.id)
    this.#map.set(s.id, s)
  }

  /** Add a new session, first evicting the token's (then the instance's) least recently used one at the cap. */
  add(s: McpSession): void {
    s.lastSeenAt = this.now()
    const mine = [...this.#map.values()].filter((x) => x.tokenId === s.tokenId)
    for (let i = 0; i <= mine.length - this.perToken; i++) this.remove((mine[i] as McpSession).id)
    while (this.#map.size >= this.total) {
      const oldest = this.#map.keys().next().value as string
      this.remove(oldest)
    }
    this.#map.set(s.id, s)
  }

  /** Forget and close a session (DELETE, eviction, idle). Idempotent. */
  remove(id: string): void {
    const s = this.#map.get(id)
    if (!s) return
    this.#map.delete(id)
    void s.mcp.close().catch(() => {})
  }

  /** Drop sessions idle past the TTL; returns how many went. */
  sweep(): number {
    const cutoff = this.now() - this.ttlMs
    let n = 0
    for (const s of [...this.#map.values()]) {
      if (s.lastSeenAt < cutoff) {
        this.remove(s.id)
        n++
      }
    }
    return n
  }

  /** Sessions of one token (tests, diagnostics). */
  countFor(tokenId: string): number {
    let n = 0
    for (const s of this.#map.values()) if (s.tokenId === tokenId) n++
    return n
  }

  closeAll(): void {
    for (const id of [...this.#map.keys()]) this.remove(id)
  }
}
