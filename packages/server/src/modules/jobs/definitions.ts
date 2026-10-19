/**
 * The job table of cleanup-and-jobs.md section 4. Cadence and leases are design constants, not config
 * (deployment.md section 5). `mcp-session-sweep` is in-memory per process and belongs to the MCP module.
 */
import type { JobName } from '../../ports.js'
import { runCleanup } from './cleanup.js'
import { runPurgeEphemeral } from './purge.js'
import { embedPendingHandler, noopSearchJobs, reembedHandler, type SearchJobs } from './search-jobs.js'
import type { JobDefinition } from './types.js'

const MIN = 60_000
const HOUR = 60 * MIN

export const JOB_SCHEDULE: Record<JobName, { everyMs: number; leaseMs: number; budgetMs?: number }> = {
  cleanup: { everyMs: HOUR, leaseMs: 10 * MIN },
  'embed-pending': { everyMs: MIN, leaseMs: 5 * MIN, budgetMs: 4 * MIN },
  reembed: { everyMs: MIN, leaseMs: 5 * MIN },
  'purge-ephemeral': { everyMs: HOUR, leaseMs: 5 * MIN },
}

export function jobDefinitions(opts: { searchJobs?: SearchJobs } = {}): JobDefinition[] {
  const search = opts.searchJobs ?? noopSearchJobs
  return [
    { name: 'cleanup', ...JOB_SCHEDULE.cleanup, handler: (ctx) => runCleanup(ctx, search) },
    {
      name: 'embed-pending',
      ...JOB_SCHEDULE['embed-pending'],
      recordOnlyWithWork: true,
      handler: embedPendingHandler(search),
    },
    { name: 'reembed', ...JOB_SCHEDULE.reembed, recordOnlyWithWork: true, handler: reembedHandler(search) },
    { name: 'purge-ephemeral', ...JOB_SCHEDULE['purge-ephemeral'], handler: runPurgeEphemeral },
  ]
}
