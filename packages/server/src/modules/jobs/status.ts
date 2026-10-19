/**
 * Job status for admins (api.md section 10): the instance view (`GET /api/v1/jobs`, IA), the per-project view
 * with re-embed progress (`GET /api/v1/projects/:slug/jobs`, PA / IA), and the admin "run now" trigger.
 */
import { type AnyColumn, and, desc, eq, inArray, sql } from 'drizzle-orm'
import { items, jobLocks, jobRuns } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { JOB_NAMES, type JobName } from '../../ports.js'
import type { UserContext } from '../auth/index.js'
import type { ProjectAccess } from '../projects/index.js'
import type { RunNowResult, Scheduler } from './scheduler.js'
import type { JobDefinition } from './types.js'

const RECENT_INSTANCE = 50
const RECENT_PROJECT = 20
/** Jobs whose per-project runs the project page lists. */
const PROJECT_JOBS = ['reembed', 'cleanup'] as const

export interface JobRunJson {
  id: number
  name: string
  project_id: string | null
  started_at: string
  finished_at: string | null
  status: string
  stats: Record<string, unknown>
  error: string | null
}

const runColumns = {
  id: jobRuns.id,
  name: jobRuns.name,
  projectId: jobRuns.projectId,
  startedAt: jobRuns.startedAt,
  finishedAt: jobRuns.finishedAt,
  status: jobRuns.status,
  stats: jobRuns.stats,
  error: jobRuns.error,
}

type RunRow = {
  id: number
  name: string
  projectId: string | null
  startedAt: Date
  finishedAt: Date | null
  status: string
  stats: Record<string, unknown>
  error: string | null
}

export function jobRunJson(r: RunRow): JobRunJson {
  return {
    id: r.id,
    name: r.name,
    project_id: r.projectId,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
    status: r.status,
    stats: r.stats,
    error: r.error,
  }
}

/** `-infinity` (a released lease) has no JS Date; read lease times as text and map them. */
const tsText = (col: AnyColumn) =>
  sql<string | null>`CASE WHEN ${col} IS NULL OR ${col} = '-infinity' THEN NULL
    ELSE to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`

export function isJobName(name: string): name is JobName {
  return (JOB_NAMES as readonly string[]).includes(name)
}

export class JobStatusService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly scheduler: Pick<Scheduler, 'definitions' | 'runNow' | 'runningJobs' | 'enabled'>,
  ) {}

  #definitions(): Map<string, JobDefinition> {
    return new Map(this.scheduler.definitions().map((d) => [d.name, d]))
  }

  /** `GET /api/v1/jobs` (the caller is an instance admin). */
  async instance() {
    const defs = this.#definitions()
    const locks = await this.deps.db
      .select({
        name: jobLocks.name,
        lockedUntil: tsText(jobLocks.lockedUntil),
        lockedBy: jobLocks.lockedBy,
        lastRunAt: tsText(jobLocks.lastRunAt),
        lastStatus: jobLocks.lastStatus,
        lastError: jobLocks.lastError,
      })
      .from(jobLocks)
    const byName = new Map(locks.map((l) => [l.name, l]))
    const names = [...new Set([...defs.keys(), ...byName.keys()])].sort()
    const running = new Set<string>(this.scheduler.runningJobs())
    const recent = await this.deps.db
      .select(runColumns)
      .from(jobRuns)
      .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
      .limit(RECENT_INSTANCE)
    return {
      scheduler: { enabled: this.scheduler.enabled },
      jobs: names.map((name) => {
        const l = byName.get(name)
        const d = defs.get(name)
        return {
          name,
          every_s: d ? Math.round(d.everyMs / 1000) : null,
          last_run_at: l?.lastRunAt ?? null,
          last_status: l?.lastStatus ?? null,
          last_error: l?.lastError ?? null,
          locked_until: l?.lockedUntil ?? null,
          locked_by: l?.lockedUntil ? (l.lockedBy ?? null) : null,
          running_here: running.has(name),
        }
      }),
      recent: recent.map(jobRunJson),
    }
  }

  /** `GET /api/v1/projects/:slug/jobs`: re-embed progress and the project's own runs. */
  async project(access: ProjectAccess) {
    access.assert('jobs.read')
    const p = access.project
    let remaining = 0
    if (p.embeddingTarget !== null) {
      const [row] = await this.deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(items)
        .where(
          and(
            eq(items.projectId, p.id),
            sql`NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = ${items.id}
                  AND c.model = ${p.embeddingTarget} AND c.item_revision = ${items.revision})`,
          ),
        )
      remaining = row?.n ?? 0
    }
    const runs = await this.deps.db
      .select(runColumns)
      .from(jobRuns)
      .where(and(eq(jobRuns.projectId, p.id), inArray(jobRuns.name, [...PROJECT_JOBS])))
      .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
      .limit(RECENT_PROJECT)
    return {
      embedding: {
        model: p.embeddingModel,
        target: p.embeddingTarget,
        remaining,
        providers_enabled: this.deps.ports.embeddings.list().map((e) => e.name),
      },
      runs: runs.map(jobRunJson),
    }
  }

  /**
   * `POST /api/v1/jobs/:name/run` (instance admin): take the lease now, skipping the due check, and run the
   * handler in the background. Audited as `job.run` (instance level).
   */
  async runNow(ctx: UserContext, name: string): Promise<{ name: JobName } & RunNowResult> {
    if (!ctx.user.isAdmin) throw new ApiError('forbidden', { message: 'Instance admins only.' })
    if (!isJobName(name)) throw new ApiError('not_found', { message: 'No such job.' })
    const result = await this.scheduler.runNow(name)
    await writeAudit(this.deps.db, webActor(ctx), {
      action: 'job.run',
      summary: result.started ? `started job ${name}` : `job ${name} not started (${result.reason})`,
      data: { name, started: result.started, ...(result.started ? {} : { reason: result.reason }) },
    })
    return { name, ...result }
  }
}
