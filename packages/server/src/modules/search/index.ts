/**
 * Search module: chunker, embedding providers (local ONNX e5-small q8, OpenAI, Voyage) and their registry,
 * the SearchPort implementation (prepare/index chunks, near-duplicate candidates), hybrid FTS + vector search
 * with RRF, the `spoor_context` digest, the anchor matcher, and the embed-pending / re-embed job functions.
 * Design: docs/design/search-and-digest.md (all sections), api.md 4.1, 6, 7.1.
 *
 * Wiring (src/index.ts, app.ts):
 *   const embeddings = createEmbeddingRegistry(config)            // Ports.embeddings
 *   const search = createSearchModule({ ...deps, ports: { ...ports, embeddings } })
 *   ports.search = search.search                                   // SearchPort
 *   api.route('/', search.routes); bearerApi.route('/', search.bearerRoutes)
 *   jobs: search.jobs.embedPending(ctx), search.jobs.reembed(ctx), search.jobs.chunkSweep(ctx)
 *   startup step 7: await search.jobs.syncEmbeddingTargets()
 */
import type { ServerDeps } from '../../lib/deps.js'
import type { SearchJobs } from '../../ports.js'
import { ContextService } from './context.js'
import { consistencySweep, embedPending, type JobContext, reembed, syncEmbeddingTargets } from './jobs.js'
import { searchBearerRoutes, searchRoutes } from './routes.js'
import { SearchService } from './service.js'

export { CHUNK_MAX, CHUNK_OVERLAP, type ChunkInput, chunkItem, type TokenCounter } from './chunker.js'
export { BUDGET_MAX, BUDGET_MIN, type ContextParams, ContextService } from './context.js'
export {
  buildDigest,
  type DigestCandidate,
  type DigestResult,
  FRAMING_LINE,
  formatDigestLine,
  itemTag,
  truncateTitle,
} from './digest.js'
export { formatSearchLine, formatSearchResults, loadItemSummaries } from './format.js'
export {
  consistencySweep,
  dropHnswIndexIfUnused,
  embedPending,
  ensureHnswIndex,
  type JobContext,
  reembed,
  syncEmbeddingTargets,
} from './jobs.js'
export { LOCAL_TAG, LocalE5Provider } from './providers/local.js'
export { createEmbeddingRegistry, ProviderRegistry, providerForSettings } from './providers/registry.js'
export { OpenAIProvider, VoyageProvider } from './providers/remote.js'
export { buildTsQuery, RRF_K, rrfFuse } from './query.js'
export { RELATED_KNN, RELATED_KNN_PER_RESULT, RELATED_PROBE_MAX, relatedKnn } from './related.js'
export { contextQuery, searchQuery } from './routes.js'
export {
  firstDuplicate,
  NOTE_REEMBEDDING,
  NOTE_VECTOR_UNAVAILABLE,
  type SearchHit,
  type SearchParams,
  type SearchResult,
  SearchService,
} from './service.js'
export { differentValues, factValues } from './values.js'

export function createSearchModule(deps: ServerDeps) {
  const search = new SearchService(deps)
  const context = new ContextService(deps, search)
  return {
    name: 'search',
    /** Implements SearchPort; also `search.search()` for spoor_search. */
    search,
    /** `context.build()` for spoor_context and the REST digest. */
    context,
    routes: searchRoutes(deps, { search, context }),
    bearerRoutes: searchBearerRoutes({ search, context }),
    /** `SearchJobs` of src/ports.ts (src/runtime.ts registers it with the scheduler as is), plus startup's sync. */
    jobs: {
      embedPending: (ctx?: JobContext) => embedPending(deps, ctx),
      reembed: (ctx?: JobContext) => reembed(deps, ctx),
      chunkSweep: (ctx?: JobContext) => consistencySweep(deps, search, ctx),
      syncEmbeddingTargets: () => syncEmbeddingTargets(deps),
    } satisfies SearchJobs & { syncEmbeddingTargets: () => Promise<string[]> },
  }
}

export type SearchModule = ReturnType<typeof createSearchModule>
