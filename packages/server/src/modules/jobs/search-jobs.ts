/**
 * The scheduler side of the search module's background work (search-and-digest.md section 3). The contract
 * (`SearchJobs`, `BatchContext`) lives in src/ports.ts; src/runtime.ts passes the search module's `jobs`
 * straight to `registerJobs`. `noopSearchJobs` is what a scheduler built without the search module runs
 * (tests of the scheduler itself), so cleanup and purge still work on their own.
 */
import type { SearchJobs } from '../../ports.js'
import type { JobHandler, JobStats } from './types.js'

export type { SearchJobs } from '../../ports.js'

export const noopSearchJobs: SearchJobs = {
  embedPending: async () => ({ embedded: 0, remaining: 0 }),
  reembed: async () => ({ projects: 0 }),
  chunkSweep: async () => ({ rechunked: 0 }),
}

const positive = (v: unknown) => typeof v === 'number' && v > 0

/** True when stats say the run did or attempted something (then it gets a `job_runs` row). */
export function hadWork(stats: JobStats, keys: string[]): boolean {
  return keys.some((k) => positive(stats[k]))
}

/** `embed-pending`: records a run only when there was work (cleanup-and-jobs.md section 4). */
export function embedPendingHandler(search: Pick<SearchJobs, 'embedPending'>): JobHandler {
  return async (ctx) => {
    const stats = await search.embedPending(ctx)
    if (hadWork(stats, ['embedded', 'remaining'])) await ctx.markWork()
    return stats
  }
}

/** `reembed`: records a run only when a project had a target (it runs every minute). */
export function reembedHandler(search: Pick<SearchJobs, 'reembed'>): JobHandler {
  return async (ctx) => {
    const stats = await search.reembed(ctx)
    if (hadWork(stats, ['projects', 'embedded', 'remaining'])) await ctx.markWork()
    return stats
  }
}
