/**
 * The digest's candidate queries (docs/design/search-and-digest.md section 7, deviation I11): five bounded
 * queries plus at most one `embedQuery` (tier 4), then the pure builder in digest.ts. Nothing here bumps
 * `last_used_at` (cleanup-and-jobs.md section 3).
 */
import { estimateTokens, normalizeFiles, scoreAnchors } from '@spoor/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { ServerDeps } from '../../lib/deps.js'
import type { Space } from '../../ports.js'
import { itemHandle } from '../items/index.js'
import { resolveSettings } from '../projects/index.js'
import { buildDigest, type DigestCandidate, type DigestResult, type TierId } from './digest.js'
import type { SearchService } from './service.js'
import { DIGEST_ELIGIBLE, inList, type ProjectModels, projectModels, sharedProjectModels } from './sql.js'

export const BUDGET_MIN = 200
export const BUDGET_MAX = 8000
const CAP = { pinned: 50, decisions: 20, anchored: 30, relevant: 15, verified: 60 } as const
/** Anchored items read per project for in-process matching (items_anchored_idx rows). */
const ANCHORED_SCAN_MAX = 5000

export interface ContextParams {
  projectId: string
  budget?: number
  query?: string | null
  files?: readonly string[]
  includeShared?: boolean
}

type Row = {
  id: string
  project_id: string
  space: Space
  number: number
  adr_number: number | null
  title: string
  type: string | null
  status: string
  provenance: string
  confidence: string | null
  decided_on: string | null
  expires_at: Date | string | null
  anchors: string[]
  last_verified_at: Date | string
}

const COLUMNS = sql.raw(`i.id, i.project_id, i.space, i.number, i.adr_number, i.title, i.type, i.status,
  i.provenance, i.confidence, i.decided_on::text AS decided_on, i.expires_at, i.anchors, i.last_verified_at`)

export class ContextService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly search: SearchService,
  ) {}

  async #rows(where: SQL, order: SQL, limit: number): Promise<Row[]> {
    const res = await this.deps.db.execute<Row>(
      sql`SELECT ${COLUMNS} FROM items i WHERE ${where} AND ${DIGEST_ELIGIBLE} ORDER BY ${order} LIMIT ${limit}`,
    )
    return res.rows
  }

  /** Build the digest for a project; `est(text) <= budget` always. */
  async build(params: ContextParams): Promise<DigestResult> {
    const project = await projectModels(this.deps.db, params.projectId)
    if (!project) throw new Error(`context: no project ${params.projectId}`)
    const settings = resolveSettings(project.settings)
    const budget = Math.min(
      BUDGET_MAX,
      Math.max(BUDGET_MIN, Math.trunc(params.budget ?? settings.digest.default_budget)),
    )
    const days = settings.digest.decision_window_days
    const query = params.query?.trim() ? params.query.trim() : null
    const files = normalizeFiles(params.files ?? [])

    let shared: ProjectModels | undefined
    if ((params.includeShared ?? true) && project.kind !== 'shared')
      shared = await sharedProjectModels(this.deps.db)
    const scopeIds = [project.id, ...(shared ? [shared.id] : [])]
    const toCandidate = (r: Row, anchor?: string | null): DigestCandidate => ({
      id: r.id,
      handle: itemHandle(
        { space: r.space, number: r.number, adrNumber: r.adr_number },
        shared !== undefined && r.project_id === shared.id,
      ),
      agent: r.provenance === 'agent',
      space: r.space,
      type: r.type,
      status: r.status,
      title: r.title,
      confidence: r.confidence,
      decidedOn: r.decided_on,
      expiresAt: r.expires_at === null ? null : new Date(r.expires_at),
      anchor: anchor ?? null,
    })

    // 1. pinned (project + shared): decisions, docs, memories; then updated_at desc
    const pinned = await this.#rows(
      sql`i.project_id IN ${inList(scopeIds)} AND i.pinned`,
      sql`CASE i.space WHEN 'decisions' THEN 0 WHEN 'docs' THEN 1 ELSE 2 END, i.updated_at DESC, i.id`,
      CAP.pinned,
    )
    // 2. accepted ADRs decided within the window (project + shared)
    const decisions = await this.#rows(
      sql`i.project_id IN ${inList(scopeIds)} AND i.space = 'decisions' AND i.status = 'accepted'
          AND i.decided_on >= current_date - ${days}::int`,
      sql`i.decided_on DESC, i.adr_number DESC, i.id`,
      CAP.decisions,
    )
    // 3. anchored (project only): match strength desc, more matched files, last_verified_at desc
    let anchored: DigestCandidate[] = []
    if (files.length > 0) {
      const rows = await this.#rows(
        sql`i.project_id = ${project.id} AND cardinality(i.anchors) > 0`,
        sql`i.last_verified_at DESC, i.id`,
        ANCHORED_SCAN_MAX,
      )
      anchored = rows
        .map((r) => ({ r, s: scoreAnchors(r.anchors, files) }))
        .filter((x) => x.s.strength > 0)
        .sort(
          (a, b) =>
            b.s.strength - a.s.strength ||
            b.s.matchedFiles - a.s.matchedFiles ||
            new Date(b.r.last_verified_at).getTime() - new Date(a.r.last_verified_at).getTime(),
        )
        .slice(0, CAP.anchored)
        .map((x) => toCandidate(x.r, x.s.anchor))
    }
    // 4. relevant: hybrid search restricted to eligible items (project + shared)
    let relevant: DigestCandidate[] = []
    if (query) {
      const res = await this.search.search({
        projectId: project.id,
        query,
        limit: CAP.relevant,
        includeShared: shared !== undefined,
        includeInactive: false,
        digestEligible: true,
      })
      relevant = res.hits.map((h) => ({
        id: h.id,
        handle: itemHandle(h, h.shared),
        agent: h.provenance === 'agent',
        space: h.space,
        type: h.type,
        status: h.status,
        title: h.title,
        confidence: h.confidence,
        decidedOn: h.decidedOn,
        expiresAt: h.expiresAt,
      }))
    }
    // 5. recently verified (project only, all spaces)
    const verified = await this.#rows(
      sql`i.project_id = ${project.id}`,
      sql`i.last_verified_at DESC, i.id`,
      CAP.verified,
    )

    const tiers: Record<TierId, DigestCandidate[]> = {
      1: pinned.map((r) => toCandidate(r)),
      2: decisions.map((r) => toCandidate(r)),
      3: anchored,
      4: relevant,
      5: verified.map((r) => toCandidate(r)),
    }
    const result = buildDigest({ slug: project.slug, budget, decisionWindowDays: days, query, tiers })
    if (estimateTokens(result.text) > budget) {
      // cannot happen (buildDigest guarantees it); logged loudly if it ever does
      this.deps.logger.error({ budget }, 'digest exceeded its budget')
    }
    return result
  }
}
