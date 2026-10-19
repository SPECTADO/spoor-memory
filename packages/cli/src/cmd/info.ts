/** `spoor whoami`, `spoor status`, `spoor context` (cli-and-hooks.md sections 4.5, 4.7, 4.10). */

import {
  api,
  authProblem,
  type Ctx,
  clientFor,
  failureExit,
  failureNotice,
  mcpUrlMismatch,
  projectPath,
} from '../ctx.js'
import { gitAnchors } from '../git.js'
import { offlineUntil } from '../http.js'
import { orphans } from '../mirror.js'
import { readState } from '../state.js'

export interface WhoamiResponse {
  project: { slug: string; name: string; next_adr_number: number }
  token: { id: string; name: string; kind: string; prefix: string; role: string; expires_at?: string | null }
  user: { label: string }
  server: { version: string }
}

export function whoamiLine(w: WhoamiResponse): string {
  return `${w.user.label} · ${w.project.slug} · ${w.token.role} · token "${w.token.name}" ${w.token.prefix} · server ${w.server.version}`
}

export async function cmdWhoami(ctx: Ctx, o: { json?: boolean }): Promise<number> {
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  const r = await api<WhoamiResponse>(
    clientFor(ctx, { breaker: 'off', timeoutMs: 6000 }),
    'GET',
    projectPath(ctx, '/api/whoami'),
  )
  if (r.kind !== 'ok') {
    ctx.rt.err(`${failureNotice(ctx, r)}\n`)
    return failureExit(r)
  }
  ctx.rt.out(o.json ? `${JSON.stringify(r.body, null, 2)}\n` : `${whoamiLine(r.body)}\n`)
  return 0
}

export async function cmdStatus(ctx: Ctx, o: { remote?: boolean }): Promise<number> {
  const out: string[] = []
  const cfg = ctx.cfg
  out.push(`repo     ${ctx.root}`)
  out.push(`server   ${cfg?.server ? `${cfg.server.value} (${cfg.server.source})` : 'not set'}`)
  out.push(`project  ${cfg?.project ? `${cfg.project.value} (${cfg.project.source})` : 'not set'}`)
  const state = readState(ctx.root)
  if (cfg?.token) {
    const prefix = cfg.token.value.slice(0, 12)
    const login = state.login && cfg.token.value.startsWith(state.login.prefix) ? state.login : undefined
    const exp = login?.expires_at
      ? `expires ${login.expires_at.slice(0, 10)}`
      : login?.no_expiry
        ? 'no expiry'
        : 'expiry unknown'
    out.push(`token    ${prefix}… (${cfg.token.source}, ${exp})`)
    if (login?.role) out.push(`role     ${login.role} (at login; --remote asks the server)`)
  } else out.push('token    not set')
  if (ctx.configError) out.push(`config   ${ctx.configError}`)
  if (ctx.repoError) out.push(`config   ${ctx.repoError}`)
  const mismatch = mcpUrlMismatch(ctx)
  if (mismatch) out.push(`warning  ${mismatch}`)
  // local state only: whether hooks currently skip the network, not whether the server answers (--remote does)
  const until = offlineUntil({ repoRoot: ctx.root, now: ctx.rt.now })
  out.push(
    `breaker  ${until ? `open until ${new Date(until).toISOString()} (hooks skip the network)` : 'closed (hooks use the network)'}`,
  )

  if (state.conflicts.length > 0) {
    out.push(
      '',
      `Push conflicts (${state.conflicts.length}): the file and Spoor differ; a human resolves each one.`,
    )
    for (const c of state.conflicts) {
      const by = c.edited_by ? ` by ${c.edited_by}` : ''
      const cmd = c.path.startsWith(`${ctx.repo.adr_dir}/`) ? 'spoor adr push' : 'spoor docs push'
      out.push(`  ${c.path} (${c.handle}) edited in Spoor${by} since ${c.since}`)
      out.push(`    to overwrite Spoor with the file: ${cmd} ${c.path} --force`)
    }
  }
  if (state.pending.length > 0) {
    out.push('', `Queued pushes (${state.pending.length}), replayed at the next session start:`)
    for (const p of state.pending) out.push(`  ${p.path} (since ${p.since})`)
  }
  const orph = orphans(ctx, state)
  if (orph.length > 0) {
    out.push(
      '',
      `Orphaned mirror files (${orph.length}): deleted or renamed locally; retire them in the web UI.`,
    )
    for (const o of orph) out.push(`  ${o.base.path} (${o.base.handle ?? o.id})`)
  }
  const undrafted = Object.entries(state.drafted).filter(([, d]) => !d.pushed)
  if (undrafted.length > 0) {
    out.push('', `Drafted ADRs not pushed yet (${undrafted.length}):`)
    for (const [h, d] of undrafted) out.push(`  ${h} → ${d.path}`)
  }
  let code = state.conflicts.length > 0 || orph.length > 0 ? 2 : 0
  if (o.remote) {
    const problem = authProblem(ctx)
    if (problem) {
      out.push('', `remote   ${problem}`)
      code = Math.max(code, 1)
    } else {
      const r = await api<WhoamiResponse>(
        clientFor(ctx, { breaker: 'off', timeoutMs: 6000 }),
        'GET',
        projectPath(ctx, '/api/whoami'),
      )
      if (r.kind === 'ok') {
        const e = r.body.token?.expires_at
        const exp =
          typeof e === 'string' ? `expires ${e.slice(0, 10)}` : e === null ? 'no expiry' : 'expiry unknown'
        out.push('', `remote   ${whoamiLine(r.body)} · ${exp}`)
      } else {
        out.push('', `remote   ${failureNotice(ctx, r)}`)
        code = Math.max(code, failureExit(r))
      }
    }
  }
  ctx.rt.out(`${out.join('\n')}\n`)
  return code
}

export interface ContextOpts {
  query?: string
  files?: string[]
  git?: boolean
  budget?: number
  noShared?: boolean
  json?: boolean
  strict?: boolean
}

/** Query string for `GET /p/:slug/api/context`. */
export function contextQuery(o: {
  files: string[]
  query?: string
  budget?: number
  noShared?: boolean
  json?: boolean
}) {
  const q = new URLSearchParams()
  if (o.budget !== undefined) q.set('budget', String(o.budget))
  if (o.query) q.set('query', o.query.slice(0, 500))
  for (const f of o.files) q.append('file', f)
  if (o.noShared) q.set('include_shared', 'false')
  if (o.json) q.set('format', 'json')
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function cmdContext(ctx: Ctx, o: ContextOpts): Promise<number> {
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return o.strict ? 1 : 0
  }
  let files = (o.files ?? []).map((f) => f.trim()).filter((f) => f !== '')
  if (o.git) files = await gitAnchors(ctx.root, ctx.repo.context.max_files, 2000, ctx.rt.now)
  files = files.slice(0, 200)
  const max = ctx.repo.context.max_tokens
  const budget = o.budget === undefined ? undefined : Math.max(200, Math.min(o.budget, max))
  const qo: Parameters<typeof contextQuery>[0] = { files }
  if (o.query !== undefined) qo.query = o.query
  if (budget !== undefined) qo.budget = budget
  if (o.noShared) qo.noShared = true
  if (o.json) qo.json = true
  const r = await api<unknown>(
    clientFor(ctx, { breaker: 'trip', timeoutMs: 4000 }),
    'GET',
    projectPath(ctx, `/api/context${contextQuery(qo)}`),
  )
  if (r.kind !== 'ok') {
    ctx.rt.err(`${failureNotice(ctx, r)}\n`)
    return o.strict ? failureExit(r) : 0
  }
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)
  ctx.rt.out(text.endsWith('\n') ? text : `${text}\n`)
  return 0
}
