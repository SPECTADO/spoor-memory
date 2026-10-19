/** `spoor adr import|push`, `spoor docs import|push` (cli-and-hooks.md sections 4.2 to 4.4). */
import { api, authProblem, type Ctx, clientFor, failureExit, failureNotice, projectPath } from '../ctx.js'
import {
  adrFiles,
  applyPushResult,
  docFiles,
  highestAdrNumber,
  importBatches,
  isAdrPath,
  isDocPath,
  type PushOutcome,
  type PushResult,
  pushFile,
  readFileText,
  repoRelative,
} from '../mirror.js'
import { pushResultProblem } from '../safety.js'
import type { MirrorKind } from '../state.js'

interface ImportError {
  source_path: string
  error: string
  message?: string
}

const isError = (r: PushResult | ImportError): r is ImportError => 'error' in r

export async function cmdAdrImport(
  ctx: Ctx,
  o: { dir?: string; dryRun?: boolean; json?: boolean },
): Promise<number> {
  if (o.dir) ctx.repo.adr_dir = o.dir.replace(/^\.\//, '').replace(/\/+$/, '')
  const { files, skipped } = adrFiles(ctx)
  const reserveAbove = highestAdrNumber(ctx, files)
  const payload = files.map((source_path) => ({ source_path, content: readFileText(ctx, source_path) ?? '' }))
  const batches = importBatches(payload)
  for (const s of skipped) ctx.rt.out(`skipped ${s}\n`)
  if (o.dryRun) {
    for (const f of files) ctx.rt.out(`would import ${f}\n`)
    ctx.rt.out(`${files.length} files in ${batches.length} request(s), reserve_above ${reserveAbove}\n`)
    return 0
  }
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  if (files.length === 0) {
    ctx.rt.out(`no ADR files in ${ctx.repo.adr_dir}\n`)
    return 0
  }
  const client = clientFor(ctx, { breaker: 'off', timeoutMs: 30_000 })
  const counts = { created: 0, updated: 0, unchanged: 0, renumbered: 0, errors: 0 }
  const renumbered: string[] = []
  for (const batch of batches) {
    const r = await api<{ results: (PushResult | ImportError)[] }>(
      client,
      'POST',
      projectPath(ctx, '/api/adr/import'),
      {
        body: { files: batch, reserve_above: reserveAbove },
      },
    )
    if (r.kind !== 'ok') {
      ctx.rt.err(`${failureNotice(ctx, r)}\n`)
      return failureExit(r)
    }
    if (o.json) ctx.rt.out(`${JSON.stringify(r.body, null, 2)}\n`)
    // Only paths this batch sent are ever written (review-log-phase5 S1): a result for any other path, or a second
    // result for the same path, is a protocol error and is dropped without touching a file.
    const sent = new Set(batch.map((f) => f.source_path))
    const results = Array.isArray(r.body?.results) ? r.body.results : []
    for (const res of results) {
      const path = res && typeof res === 'object' ? res.source_path : undefined
      if (typeof path !== 'string' || !sent.has(path)) {
        counts.errors++
        ctx.rt.out('error: the server answered for a file this batch did not send; ignored\n')
        continue
      }
      sent.delete(path)
      if (isError(res)) {
        counts.errors++
        ctx.rt.out(`error ${path}: ${res.error}${res.message ? ` (${res.message})` : ''}\n`)
        continue
      }
      const problem = pushResultProblem(res)
      if (problem) {
        counts.errors++
        ctx.rt.out(`error ${path}: unexpected import result (${problem}); file not changed\n`)
        continue
      }
      counts[res.status]++
      const applied = await applyPushResult(ctx, 'adr', path, res)
      if (res.renumbered) {
        counts.renumbered++
        renumbered.push(applied.path)
      }
      if (!o.json) ctx.rt.out(`${res.status} ${applied.path} ${res.handle} r${res.revision}\n`)
      for (const n of applied.notes) ctx.rt.out(`${n}\n`)
    }
  }
  // renamed files: push once more so Spoor's source_path and `adr:` follow the file
  for (const path of renumbered) {
    const out = await pushFile(ctx, client, 'adr', path, { noQueue: true, followUp: true })
    if (out.kind !== 'pushed') ctx.rt.out(`warning: follow-up push of ${path}: ${describe(out)}\n`)
  }
  ctx.rt.out(
    `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.renumbered} renumbered, ${counts.errors} errors\n`,
  )
  if (counts.created + counts.updated + counts.renumbered > 0)
    ctx.rt.out('ADR files got a spoor_id line in their frontmatter; commit that change.\n')
  return counts.errors > 0 ? 2 : 0
}

export async function cmdDocsImport(ctx: Ctx, o: { dryRun?: boolean; json?: boolean }): Promise<number> {
  const files = docFiles(ctx)
  if (o.dryRun) {
    for (const f of files) ctx.rt.out(`would import ${f}\n`)
    ctx.rt.out(`${files.length} files in ${files.length} request(s)\n`)
    return 0
  }
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  const client = clientFor(ctx, { breaker: 'off', timeoutMs: 30_000 })
  const counts = { created: 0, updated: 0, unchanged: 0, errors: 0 }
  for (const path of files) {
    const out = await pushFile(ctx, client, 'doc', path, { noQueue: true })
    if (out.kind === 'pushed') {
      counts[out.result.status]++
      if (o.json) ctx.rt.out(`${JSON.stringify(out.result)}\n`)
      else ctx.rt.out(`${out.result.status} ${out.path} ${out.result.handle} r${out.result.revision}\n`)
      for (const n of out.notes) ctx.rt.out(`${n}\n`)
      continue
    }
    if (out.kind === 'queued' || out.kind === 'unauthorized') {
      ctx.rt.err(`${outcomeNotice(ctx, out)}\n`)
      return 3
    }
    counts.errors++
    ctx.rt.out(`error ${path}: ${describe(out)}\n`)
  }
  ctx.rt.out(
    `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.errors} errors\n`,
  )
  return counts.errors > 0 ? 2 : 0
}

export function describe(o: PushOutcome): string {
  switch (o.kind) {
    case 'pushed':
      return `${o.result.handle} r${o.result.revision} ${o.result.status}`
    case 'conflict':
      return `${o.handle} was edited in Spoor${o.editedBy ? ` (by ${o.editedBy}${o.via ? ` via ${o.via}` : ''})` : ''} after your last push. Nothing was pushed.`
    case 'already_drafted':
      return `${o.handle} was already drafted as ${o.adr}`
    case 'error':
      return `${o.code}${o.message ? `: ${o.message}` : ''}`
    case 'queued':
      return `server unreachable (${o.code}); queued`
    case 'unauthorized':
      return 'token rejected (401)'
    case 'missing':
      return 'file not found'
  }
}

function outcomeNotice(ctx: Ctx, o: PushOutcome): string {
  if (o.kind === 'queued')
    return `spoor: server unreachable (${o.code} ${ctx.server ?? ''}); skipped. It will retry on the next session.`
  if (o.kind === 'unauthorized') return `spoor: token rejected by ${ctx.server ?? ''} (401). Run: spoor login`
  return `spoor: ${describe(o)}`
}

/**
 * `spoor adr push <file> [--force]` and `spoor docs push <file>`. Agent-facing: server down, token rejected or
 * not configured print one notice and exit 0 (`--strict`: 3 / 1). A conflict exits 2 with nothing pushed.
 */
export async function cmdPush(
  ctx: Ctx,
  kind: MirrorKind,
  file: string | undefined,
  o: { force?: boolean; strict?: boolean },
): Promise<number> {
  const label = kind === 'adr' ? 'adr' : 'docs'
  if (!file) {
    ctx.rt.err(`usage: spoor ${label} push <file>${kind === 'adr' ? ' [--force]' : ''}\n`)
    return 1
  }
  const rel = repoRelative(ctx.root, file, ctx.rt.cwd)
  if (!rel || (kind === 'adr' ? !isAdrPath(ctx, rel) : !isDocPath(ctx, rel))) {
    ctx.rt.err(
      kind === 'adr'
        ? `spoor: ${file} is not an ADR file in ${ctx.repo.adr_dir}/\n`
        : `spoor: ${file} is not in the docs list of spoor.config.json\n`,
    )
    return 1
  }
  if (readFileText(ctx, rel) === undefined) {
    ctx.rt.err(`spoor: ${file} does not exist\n`)
    return 1
  }
  if (o.force && !ctx.rt.isTTY) {
    ctx.rt.err('spoor: --force needs an interactive terminal and a typed confirmation\n')
    return 1
  }
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return o.strict ? 1 : 0
  }
  const client = clientFor(ctx, { breaker: 'trip' })
  let out = await pushFile(ctx, client, kind, rel)
  if (out.kind === 'conflict' && o.force) {
    const who = out.editedBy ? ` by ${out.editedBy}${out.via ? ` via ${out.via}` : ''}` : ''
    const answer = await ctx.rt.prompt(
      `${out.handle} was edited in Spoor${who} after your last push. Overwrite Spoor with ${rel}? Type y to confirm: `,
    )
    if (answer.trim().toLowerCase() !== 'y') {
      ctx.rt.err('spoor: not confirmed; nothing was pushed\n')
      return 2
    }
    out = await pushFile(ctx, client, kind, rel, { force: true })
  }
  switch (out.kind) {
    case 'pushed':
      ctx.rt.out(
        `${out.result.handle} r${out.result.revision} ${out.result.status}${out.path !== rel ? ` (now ${out.path})` : ''}\n`,
      )
      for (const n of out.notes) ctx.rt.out(`${n}\n`)
      return 0
    case 'conflict':
      ctx.rt.err(`${describe(out)} Resolve it in a terminal with --force, or align the file.\n`)
      return 2
    case 'already_drafted':
      ctx.rt.err(`${out.handle} already drafted as ${out.adr}\n`)
      return 2
    case 'queued':
    case 'unauthorized':
      ctx.rt.err(`${outcomeNotice(ctx, out)}\n`)
      return o.strict ? 3 : 0
    case 'missing':
      ctx.rt.err(`spoor: ${file} does not exist\n`)
      return 1
    case 'error':
      ctx.rt.err(`spoor: ${rel}: ${describe(out)}\n`)
      return 1
  }
}
