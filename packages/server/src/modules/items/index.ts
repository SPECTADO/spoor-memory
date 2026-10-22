/**
 * Items module: the item service (create, update with revision check, get, list, pin, verify, archive,
 * restore, hard delete, supersede, typed edges, wikilinks, revisions), the repo mirror (push, adr/import),
 * and the one project-scoped id resolver (data-model.md section 0). Design: data-model.md 3, 5, 6, 7;
 * api.md 5 and 7.2/7.3; mcp.md 5 (semantics); cleanup-and-jobs.md 1 to 3.
 *
 * Wiring (app.ts): mount `routes` on `/api/v1` after the cookie guards and `bearerRoutes` on `/p/:slug/api`
 * after the bearer guards. The MCP tools call `items` / `push` with a `Caller` whose `via` is `mcp`.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { PushService } from './push.js'
import { itemBearerRoutes, itemRoutes } from './routes.js'
import { ItemService } from './service.js'

export { type CanonicalInput, canonicalFrontmatter } from './markdown.js'
export { type PushError, type PushResult, PushService } from './push.js'
export {
  itemHandle,
  type ResolvedItem,
  type ResolveMode,
  type ResolveScope,
  resolveItemRef,
} from './resolve.js'
export {
  flatten as toLoadedItem,
  handleOf,
  type ItemJson,
  type ItemSummaryJson,
  type LoadedItem,
  loadedColumns,
  loadItems,
  markedHandle,
  summaryJson,
  viewOf,
} from './rows.js'
export {
  type CreateResult,
  type DuplicateHit,
  ItemService,
  mirroredItem,
  type NearDuplicate,
  type Warning,
} from './service.js'
export {
  type Caller,
  type ContentFields,
  cleanAnchors,
  cleanBody,
  cleanExtras,
  cleanTags,
  cleanTitle,
  sameContent,
} from './writes.js'

export function createItemsModule(deps: ServerDeps) {
  const items = new ItemService(deps)
  const push = new PushService(deps, items)
  return {
    name: 'items',
    items,
    push,
    /** Cookie routes; mount on `/api/v1` after `auth.cookieApiGuards`. */
    routes: itemRoutes(deps, items),
    /** Bearer routes (`push`, `adr/import`); mount on `/p/:slug/api`. */
    bearerRoutes: itemBearerRoutes(push),
  }
}

export type ItemsModule = ReturnType<typeof createItemsModule>
