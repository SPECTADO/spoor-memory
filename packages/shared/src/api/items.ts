/** Response shapes of items (docs/design/api.md section 0.6). Shared by the server, the SPA and the CLI. */
import type { Space } from '../frontmatter.js'

/**
 * `ItemSummary`: every list, search result, review section and digest row. The server builds it in ONE
 * place (`summaryJson` of the items module). Handles are relative to the viewer's project (`S:` for a shared
 * item seen from a regular project).
 */
export interface ItemSummary {
  id: string
  handle: string
  project: string
  space: Space
  number: number
  adr_number: number | null
  slug: string
  title: string
  type: string | null
  status: string
  lifecycle: string
  confidence: string | null
  tags: string[]
  anchors: string[]
  pinned: boolean
  revision: number
  provenance: string
  decided_on: string | null
  source_path: string | null
  push_conflict_at: string | null
  last_verified_at: string
  last_used_at: string | null
  expires_at: string | null
  stale_since: string | null
  archived_at: string | null
  archive_reason: string | null
  created_at: string
  updated_at: string
  updated_by: string
  client_name: string | null
}

// ---- graph and related items (BRIEF amendment 2026-10-21, ADR-0021/0022) ---------------------------------

/** Every stored edge kind (the `edges` table): the four typed relations plus the three derived ones. */
export const EDGE_KINDS = [
  'refines',
  'supports',
  'depends_on',
  'conflicts_with',
  'supersedes',
  'drafted_from',
  'wikilink',
] as const
export type GraphEdgeKind = (typeof EDGE_KINDS)[number]

/** The lifecycles the graph can filter on (default `active,stale`). */
export const GRAPH_LIFECYCLES = ['active', 'stale', 'archived'] as const
export type GraphLifecycle = (typeof GRAPH_LIFECYCLES)[number]

/** At most this many nodes per graph response; the rest is cut and `meta.truncated` is set. */
export const GRAPH_NODE_CAP = 1500

/** The parsed query of `GET …/graph` (defaults filled in). */
export interface GraphQuery {
  spaces: Space[]
  kinds: GraphEdgeKind[]
  lifecycle: GraphLifecycle[]
  /** false: status `superseded` and `deprecated` items are hidden. */
  include_superseded: boolean
  /** Keep only core nodes with no visible edge (degree 0); applied before the node cap. Default false. */
  unlinked: boolean
  /** Item ref (handle, slug or uuid): neighbourhood mode. */
  focus?: string
  /** Hops from `focus` (only with `focus`). */
  depth: 1 | 2
}
/** What a client sends: every key optional (lists go out comma-separated). */
export type GraphParams = Partial<GraphQuery>

/** A lean `ItemSummary` plus degree. Handles are viewer-relative (`S:` for a shared item seen from a project). */
export interface GraphNode
  extends Pick<
    ItemSummary,
    | 'id'
    | 'handle'
    | 'project'
    | 'space'
    | 'title'
    | 'type'
    | 'status'
    | 'lifecycle'
    | 'confidence'
    | 'pinned'
    | 'provenance'
    | 'tags'
    | 'updated_at'
    | 'last_verified_at'
  > {
  /** Kept edges ending here / starting here (before truncation). */
  degree_in: number
  degree_out: number
  /** Outside the viewed project or the active filters; present only because a kept edge reaches it. */
  ghost: boolean
}

/** One `edges` row. `dst` is `null` for a dangling wikilink, which then carries `dst_ref`. */
export interface GraphEdge {
  id: string
  kind: GraphEdgeKind
  /** Node id (item uuid). */
  src: string
  dst: string | null
  dst_ref?: string
  /** The four typed kinds; the derived ones are not removable. */
  editable: boolean
}

export interface GraphMeta {
  truncated: boolean
  node_cap: number
  /** Nodes (core and ghost) before the cap. */
  total_nodes: number
  /** Non-ghost nodes with degree 0 in the filtered graph (before the cap). */
  unlinked_count: number
  /** Distinct `dst_ref` of dangling wikilinks among the kept edges. */
  dangling_count: number
}

/** `GET /api/v1/projects/:slug/graph` (`/shared/graph` in the SPA is slug `_shared`). */
export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: GraphMeta
}

/** One suggestion of `GET …/items/:ref/related`: an unlinked item and its best-chunk cosine. */
export interface RelatedItem {
  item: ItemSummary
  /** Cosine similarity, 3 decimals. */
  cos: number
}

/** The `note` of a related response when the item has no vector under the project's active model yet. */
export const RELATED_PENDING_NOTE = 'embedding pending: related items appear once the item is embedded'

/** `GET /api/v1/projects/:slug/items/:ref/related?limit=` (default 5, max 20). */
export interface RelatedResponse {
  items: RelatedItem[]
  note?: string
}

export const RELATED_LIMIT = { default: 5, max: 20 } as const
