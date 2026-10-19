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
