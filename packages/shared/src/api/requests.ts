/**
 * The agent request log (api.md 10.3, ADR-0018): one row per MCP tool call and per CLI call on
 * `/p/:slug/api`, kept 14 days. Project admins and instance admins read it; members see only the last
 * read and the last write on the dashboard.
 */

/** A read tool / GET, or a write tool / POST. */
export const REQUEST_KINDS = ['read', 'write'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

/** `mcp`: a `spoor_*` tool call; `cli`: the spoor CLI and its hooks on the bearer REST API. */
export const REQUEST_SURFACES = ['mcp', 'cli'] as const
export type RequestSurface = (typeof REQUEST_SURFACES)[number]

/** Rows older than this are deleted by the `purge-ephemeral` job. */
export const REQUEST_LOG_KEEP_DAYS = 14

/** Who made a request: the person (or `service:<name>`), the token and the agent. */
export interface RequestActorJson {
  user_id: string | null
  /** The user's email, or `service:<token name>`. */
  label: string
  token: { id: string | null; name: string | null; prefix: string | null }
  /** MCP `initialize` client (`claude-code/2.1.303`) or the CLI user agent. */
  client_name: string | null
}

/** A row of `GET /api/v1/projects/:slug/requests`. */
export interface RequestRowJson {
  id: number
  at: string
  kind: RequestKind
  surface: RequestSurface
  /** The tool name (`spoor_search`) or `METHOD /path` (`GET /context`). */
  operation: string
  actor: RequestActorJson
  /** The space the request targeted or wrote, when there was one. */
  space: string | null
  /** The memory type the request filtered on or wrote, when there was one. */
  memory_type: string | null
  /** Handles read or written, in order (at most 50). */
  handles: string[]
  /** The search or digest query, at most 200 characters. */
  query: string | null
  /** `ok`, or the error code. */
  outcome: string
  duration_ms: number
  /** Other arguments: digest files, tags, budget, HTTP status. */
  data: Record<string, unknown>
}

/** The newest read or write of a project, for the dashboard (any member). */
export interface LastRequestJson {
  at: string
  surface: RequestSurface
  operation: string
  actor: { label: string; client_name: string | null }
}
