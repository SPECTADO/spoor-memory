/**
 * `spoor adr import|push`, `spoor docs import|push` (cli-and-hooks.md sections 4.2 to 4.4).
 *
 * The imports go through `.spoor/import-queue.json` under `.spoor/import.lock` (import-queue.ts): a re-run resumes
 * and skips what is already imported and unchanged. ADR files go in small batches in two passes: pass 1 stores the
 * content of every file (`Spoor-Import-Edges: defer`), pass 2 sends the files with links once more, when every target
 * is on the server. Both passes ask the server to embed later (`Spoor-Defer-Embedding: 1`). Failures that are worth
 * waiting for are retried with backoff (backoff.ts); anything else stops the import with a resume hint.
 */

import { basename } from 'node:path'
import {
  Backpressure,
  DEFER_EDGES,
  DEFER_EMBEDDING,
  FILE_ATTEMPTS,
  IMPORT_BATCH_BYTES,
  IMPORT_BODY_MAX,
  IMPORT_CONTENT_MAX,
  IMPORT_PATH_MAX,
  importFileBytes,
  importTimeoutMs,
  type RetryClass,
  type RetryInfo,
  retryClass,
} from '../backoff.js'
import { api, authProblem, type Ctx, clientFor, projectPath, rejectedNotice } from '../ctx.js'
import { sha256 } from '../fsutil.js'
import type { Client } from '../http.js'
import {
  acquireImportLock,
  type ImportLock,
  type ImportQueue,
  isImportLock,
  isRefused,
  type QueueEntry,
  type QueueSection,
  readImportQueue,
  writeImportQueue,
} from '../import-queue.js'
import {
  adrFiles,
  applyPushResult,
  docFiles,
  highestAdrNumber,
  type ImportFile,
  importBatches,
  isAdrPath,
  isDocPath,
  type PushOutcome,
  type PushResult,
  pushFile,
  readFileText,
  repoRelative,
  UNRESOLVED,
} from '../mirror.js'
import { pushResultProblem, validRenumber } from '../safety.js'
import { baseFor, type MirrorKind, readState } from '../state.js'
import { adrNumberOf, readSpoorId } from '../writeback.js'

interface ImportError {
  source_path: string
  error: string
  message?: string
}

const isError = (r: PushResult | ImportError): r is ImportError => 'error' in r

/** Warning codes that send a file to the second pass. */
const SECOND_PASS = new Set(['edges_deferred', 'edges_failed', ...UNRESOLVED])
const LINKS_MISSING = new Set(['edges_deferred', 'edges_failed'])
/** A file the server keeps answering `not processed` for is not re-sent forever. */
const NOT_PROCESSED_MAX = 10

type Stop =
  | { kind: 'unreachable'; code: string }
  | { kind: 'busy'; code: string }
  | { kind: 'unauthorized' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'lock' }

interface Plan {
  /** Files to send, in scan order. */
  send: string[]
  /** Files whose content is on the server but whose links are not (status `edges`). */
  links: string[]
  /** Already imported and unchanged: not sent. */
  skipped: number
  /** Refused locally (too large, path too long): never sent. */
  local: { path: string; code: string; message: string }[]
}

/** Why the server would refuse this one file, checked before sending (a refusal fails the whole batch with 400). */
function localProblem(
  kind: MirrorKind,
  path: string,
  content: string,
  reserveAbove: number,
): { code: string; message: string } | undefined {
  if (path.length > IMPORT_PATH_MAX)
    return { code: 'invalid_path', message: `the path is longer than ${IMPORT_PATH_MAX} characters` }
  if (content.length > IMPORT_CONTENT_MAX)
    return { code: 'too_large', message: `the file has more than ${IMPORT_CONTENT_MAX} characters` }
  const body =
    kind === 'adr'
      ? { files: [{ source_path: path, content }], reserve_above: reserveAbove }
      : { space: 'docs', source_path: path, content }
  if (Buffer.byteLength(JSON.stringify(body)) > IMPORT_BODY_MAX)
    return { code: 'too_large', message: 'the request would exceed the server body limit of 1 MiB' }
  return undefined
}

/**
 * ADR numbers a file names anywhere (`ADR-0007`, `adr-7`: frontmatter refs, a "Superseded by" section, prose), its own
 * number left out. Deliberately broad: a match only makes the file's links wait for that ADR, never links anything.
 */
function adrRefNumbers(path: string, content: string): Set<number> {
  const own = adrNumberOf(basename(path), content)
  const out = new Set<number>()
  for (const m of content.matchAll(/\bADR-0*(\d{1,5})\b/gi)) {
    const n = Number(m[1])
    if (n > 0 && n !== own) out.add(n)
  }
  return out
}

/** Section 6b: what to send, what only needs its links, what is skipped. Mutates `section` (dry runs pass a copy). */
function planImport(
  ctx: Ctx,
  kind: MirrorKind,
  files: string[],
  section: QueueSection,
  o: { all?: boolean; reserveAbove: number },
): Plan {
  const state = readState(ctx.root)
  const scanned = new Set(files)
  for (const p of Object.keys(section.entries)) if (!scanned.has(p)) delete section.entries[p]
  const plan: Plan = { send: [], links: [], skipped: 0, local: [] }
  for (const path of files) {
    const content = readFileText(ctx, path)
    if (content === undefined) {
      delete section.entries[path]
      continue
    }
    const h = sha256(content)
    const e = section.entries[path]
    const bad = localProblem(kind, path, content, o.reserveAbove)
    if (bad) {
      section.entries[path] = {
        status: 'failed',
        sha256: h,
        attempts: 0,
        error: bad.code,
        message: bad.message,
      }
      plan.local.push({ path, ...bad })
      continue
    }
    if (!o.all) {
      if (e && e.sha256 === h) {
        if (e.status === 'done') {
          plan.skipped++
          continue
        }
        if (e.status === 'edges') {
          plan.links.push(path)
          continue
        }
      } else {
        const b = baseFor(state, readSpoorId(content), path)
        if (b && b[1].sha256 === h && b[1].path === path) {
          section.entries[path] = { status: 'done', sha256: h, attempts: 0 }
          plan.skipped++
          continue
        }
      }
    }
    section.entries[path] = { status: 'pending', sha256: h, attempts: 0 }
    plan.send.push(path)
  }
  return plan
}

const newSection = (now: number): QueueSection => {
  const t = new Date(now).toISOString()
  return { started_at: t, updated_at: t, entries: {} }
}

const alreadyLine = (k: number) => `${k} already imported and unchanged, not sent (--all sends them again)\n`

/** One import run: the queue section, the lock, the server's health and the counts. */
class ImportRun {
  readonly bp: Backpressure
  readonly counts = { created: 0, updated: 0, unchanged: 0, renumbered: 0, errors: 0 }
  stop: Stop | undefined
  private readonly notProcessed = new Map<string, number>()

  constructor(
    readonly ctx: Ctx,
    readonly kind: MirrorKind,
    readonly q: ImportQueue,
    readonly section: QueueSection,
    readonly lock: ImportLock,
    readonly client: Client,
    readonly json: boolean,
  ) {
    this.bp = new Backpressure(ctx.rt)
  }

  out(line: string): void {
    this.ctx.rt.out(`${line}\n`)
  }

  entry(path: string): QueueEntry {
    let e = this.section.entries[path]
    if (!e) {
      e = { status: 'pending', sha256: '', attempts: 0 }
      this.section.entries[path] = e
    }
    return e
  }

  /** The entry now describes the file as it is on disk. */
  set(path: string, status: QueueEntry['status'], extra: { error?: string; message?: string } = {}): void {
    const e = this.entry(path)
    e.status = status
    e.sha256 = sha256(readFileText(this.ctx, path) ?? '')
    delete e.error
    delete e.message
    if (extra.error !== undefined) e.error = extra.error
    if (extra.message !== undefined) e.message = extra.message
  }

  fail(path: string, code: string, message?: string): void {
    this.counts.errors++
    this.out(`error ${path}: ${code}${message ? ` (${message})` : ''}`)
    this.set(path, 'failed', { error: code, ...(message ? { message } : {}) })
  }

  move(from: string, to: string): void {
    if (from === to) return
    const e = this.section.entries[from]
    delete this.section.entries[from]
    if (e) this.section.entries[to] = e
  }

  /** True while the lock is still ours; otherwise the run stops (another import took over). */
  holdsLock(): boolean {
    if (this.stop?.kind === 'lock') return false
    if (this.lock.touch(this.ctx.rt.now())) return true
    this.stop = { kind: 'lock' }
    return false
  }

  save(): void {
    if (!this.holdsLock()) return // only the holder of the import lock writes the queue
    this.section.updated_at = new Date(this.ctx.rt.now()).toISOString()
    this.q[this.kind] = this.section
    writeImportQueue(this.ctx.root, this.q)
  }

  /** Before each request: the lock must still be ours, then pacing. False stops the run. */
  async beforeRequest(): Promise<boolean> {
    if (!this.holdsLock()) return false
    await this.bp.pace()
    return true
  }

  /** Wait and let the caller send the same request again, or stop the run. */
  async retryOrStop(info: RetryInfo, cls: RetryClass, batchLen: number): Promise<void> {
    if (await this.bp.retry(info, cls, batchLen)) return
    this.stop =
      cls === 'rate' || cls === 'busy'
        ? { kind: 'busy', code: info.code }
        : { kind: 'unreachable', code: info.code }
  }

  /** A per-file `internal` (or a file without a result): try again later in this run, up to FILE_ATTEMPTS. */
  later(path: string, message: string | undefined, list: string[], pass: 1 | 2): void {
    const e = this.entry(path)
    if (message === 'not processed') {
      const n = (this.notProcessed.get(path) ?? 0) + 1
      this.notProcessed.set(path, n)
      if (n < NOT_PROCESSED_MAX) {
        list.push(path)
        return
      }
    }
    e.attempts++
    if (e.attempts < FILE_ATTEMPTS) {
      list.push(path)
      return
    }
    if (pass === 1) this.fail(path, 'internal', message ?? 'no result for this file')
    else {
      this.counts.errors++
      this.out(`warning: ${path}: links were not applied; run the command again`)
      this.set(path, 'edges')
    }
  }

  tally(total: number): { done: number; total: number; remaining: number } {
    const done = Object.values(this.section.entries).filter((e) => e.status === 'done').length
    return { done, total, remaining: Math.max(0, total - done) }
  }

  /** Section 6h: the stop notice on stderr. */
  stopNotice(total: number): void {
    const s = this.stop
    if (!s) return
    const err = (line: string) => this.ctx.rt.err(`${line}\n`)
    const server = this.ctx.server ?? ''
    if (s.kind === 'lock') {
      err(
        'spoor: another import took over this checkout; this one stopped. Run the same command again to resume.',
      )
      return
    }
    const t = this.tally(total)
    const tail = `${t.done} of ${t.total} files imported, ${t.remaining} remaining. Run the same command again to resume.`
    switch (s.kind) {
      case 'unreachable':
        err(`spoor: server unreachable (${s.code} ${server}); import stopped. ${tail}`)
        return
      case 'busy':
        err(`spoor: server busy (${s.code} ${server}); import stopped. ${tail}`)
        return
      case 'unauthorized':
        err(rejectedNotice(this.ctx))
        err(`spoor: import stopped. ${tail}`)
        return
      case 'error':
        err(`spoor: ${s.code}${s.message ? `: ${s.message}` : ''}`)
        err(`spoor: import stopped. ${tail}`)
        return
    }
  }

  exitCode(): number {
    if (this.stop?.kind === 'lock') return 1
    if (this.stop) return 3
    const open = Object.values(this.section.entries).some(
      (e) => e.status === 'failed' || e.status === 'edges',
    )
    return this.counts.errors > 0 || open ? 2 : 0
  }

  /** A refused file (isRefused) does not count: running again cannot import it until it changes. */
  refused(path: string, e: QueueEntry): boolean {
    return isRefused(this.ctx.root, path, e)
  }

  /** Files a re-run can still import (pending, or failed for a reason that is not the file's content). */
  incomplete(): boolean {
    return Object.entries(this.section.entries).some(
      ([p, e]) => e.status === 'pending' || (e.status === 'failed' && !this.refused(p, e)),
    )
  }

  /** ADR numbers of the repo files that are not on the server (yet): pending or failed entries. */
  missingNumbers(): Map<number, string> {
    const out = new Map<number, string>()
    for (const [p, e] of Object.entries(this.section.entries)) {
      if (e.status !== 'pending' && e.status !== 'failed') continue
      const n = adrNumberOf(basename(p), readFileText(this.ctx, p) ?? '')
      if (n !== undefined) out.set(n, p)
    }
    return out
  }

  /** A run that was not stopped but left work: how much remains and how to resume (section 6h). */
  finishNotice(total: number): void {
    if (this.stop) return
    const entries = Object.entries(this.section.entries)
    const refused = entries.filter(([p, e]) => this.refused(p, e)).length
    const open = entries.filter(([p, e]) => e.status !== 'done' && !this.refused(p, e)).length
    if (open === 0 && refused === 0) return
    const t = this.tally(total)
    const parts = [`${t.done} of ${t.total} files imported, ${t.remaining} remaining.`]
    if (open > 0) parts.push('Run the same command again to resume.')
    if (refused > 0)
      parts.push(
        `${refused} ${refused === 1 ? 'file was' : 'files were'} refused; fix ${refused === 1 ? 'it' : 'them'}, then run the command again.`,
      )
    this.out(parts.join(' '))
  }
}

/** Take the import lock or explain who holds it. */
function takeLock(ctx: Ctx): ImportLock | undefined {
  const lock = acquireImportLock(ctx.root, ctx.rt.now(), () => ctx.rt.now())
  if (isImportLock(lock)) return lock
  const who = lock.heldBy !== undefined ? ` (pid ${lock.heldBy})` : ''
  ctx.rt.err(
    `spoor: another import is running in this checkout${who}. Wait for it to finish, then run the command again.\n`,
  )
  return undefined
}

interface ImportBody {
  results?: unknown
}

export async function cmdAdrImport(
  ctx: Ctx,
  o: { dir?: string; dryRun?: boolean; json?: boolean; all?: boolean },
): Promise<number> {
  if (o.dir) ctx.repo.adr_dir = o.dir.replace(/^\.\//, '').replace(/\/+$/, '')
  const { files, skipped } = adrFiles(ctx)
  const reserveAbove = highestAdrNumber(ctx, files)
  for (const s of skipped) ctx.rt.out(`skipped ${s}\n`)
  if (o.dryRun) {
    const q = readImportQueue(ctx.root)
    const section: QueueSection = structuredClone(q.adr ?? newSection(ctx.rt.now()))
    const plan = planImport(ctx, 'adr', files, section, { all: o.all, reserveAbove })
    for (const f of plan.send) ctx.rt.out(`would import ${f}\n`)
    for (const f of plan.links) ctx.rt.out(`would send the links of ${f}\n`)
    for (const l of plan.local) ctx.rt.out(`would not send ${l.path}: ${l.code} (${l.message})\n`)
    const payload = plan.send.map((source_path) => ({
      source_path,
      content: readFileText(ctx, source_path) ?? '',
    }))
    ctx.rt.out(
      `${plan.send.length} files in ${importBatches(payload).length} request(s), reserve_above ${reserveAbove}\n`,
    )
    if (plan.skipped > 0) ctx.rt.out(alreadyLine(plan.skipped))
    return 0
  }
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  const lock = takeLock(ctx)
  if (!lock) return 1
  try {
    if (files.length === 0) {
      ctx.rt.out(`no ADR files in ${ctx.repo.adr_dir}\n`)
      return 0
    }
    const q = readImportQueue(ctx.root)
    const section = q.adr ?? newSection(ctx.rt.now())
    const plan = planImport(ctx, 'adr', files, section, { all: o.all, reserveAbove })
    const client = clientFor(ctx, { breaker: 'off' })
    const run = new ImportRun(ctx, 'adr', q, section, lock, client, o.json === true)
    for (const l of plan.local) {
      run.counts.errors++
      run.out(`error ${l.path}: ${l.code} (${l.message})`)
    }
    run.save()

    await adrPass(run, 1, [...plan.send], reserveAbove)
    if (!run.stop) {
      // A ref to ADR-N resolves across requests to whatever item holds N: only right once the repo's N is on the
      // server. So a file naming the number of a repo file that is not imported (pending or failed) keeps its links
      // for a later run instead of linking the wrong ADR.
      const missing = run.missingNumbers()
      const links: string[] = []
      for (const p of Object.keys(section.entries).sort()) {
        const e = section.entries[p] as QueueEntry
        if (e.status !== 'edges') continue
        const waits = [...adrRefNumbers(p, readFileText(ctx, p) ?? '')]
          .filter((n) => missing.has(n))
          .map((n) => missing.get(n) as string)
        if (waits.length > 0) {
          run.out(`note: the links of ${p} wait until ${waits.join(', ')} is imported`)
          continue
        }
        e.attempts = 0
        links.push(p)
      }
      const unresolved = await adrPass(run, 2, links, reserveAbove)
      // an unresolved target may still come with the files that did not make it: send those links again next run
      if (run.incomplete()) for (const p of unresolved) run.entry(p).status = 'edges'
      run.save()
    }

    const c = run.counts
    ctx.rt.out(
      `${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.renumbered} renumbered, ${c.errors} errors\n`,
    )
    if (plan.skipped > 0) ctx.rt.out(alreadyLine(plan.skipped))
    if (c.created + c.updated + c.renumbered > 0)
      ctx.rt.out('ADR files got a spoor_id line in their frontmatter; commit that change.\n')
    run.finishNotice(files.length)
    run.stopNotice(files.length)
    return run.exitCode()
  } finally {
    lock.release()
  }
}

/**
 * One pass over `list` (consumed from the front; retries go to the end). Pass 1 sends content only
 * (`Spoor-Import-Edges: defer`), pass 2 sends the files with links. Returns the pass-2 files left with unresolved
 * references, which the caller keeps for the next run while the import is incomplete.
 */
async function adrPass(run: ImportRun, pass: 1 | 2, list: string[], reserveAbove: number): Promise<string[]> {
  const { ctx } = run
  const unresolved: string[] = []
  while (list.length > 0 && !run.stop) {
    const head: ImportFile[] = []
    while (head.length < run.bp.maxFiles && list.length > head.length) {
      const path = list[head.length] as string
      const content = readFileText(ctx, path)
      if (content === undefined) {
        list.splice(head.length, 1)
        delete run.section.entries[path]
        continue
      }
      const bad = localProblem('adr', path, content, reserveAbove)
      if (bad) {
        list.splice(head.length, 1)
        run.fail(path, bad.code, bad.message)
        continue
      }
      head.push({ source_path: path, content })
    }
    if (head.length === 0) continue
    const batch = importBatches(head, { maxFiles: run.bp.maxFiles, maxBytes: IMPORT_BATCH_BYTES })[0] ?? head
    if (!(await run.beforeRequest())) break
    const bytes = batch.reduce((n, f) => n + importFileBytes(f), 0)
    const r = await api<ImportBody>(run.client, 'POST', projectPath(ctx, '/api/adr/import'), {
      body: { files: batch, reserve_above: reserveAbove },
      headers: pass === 1 ? { ...DEFER_EMBEDDING, ...DEFER_EDGES } : DEFER_EMBEDDING,
      timeoutMs: importTimeoutMs(bytes, ctx.rt.env),
    })
    switch (r.kind) {
      case 'ok':
        // another import took over during the request: leave its files and its queue alone
        if (!run.holdsLock()) break
        list.splice(0, batch.length)
        run.bp.ok()
        await adrResults(run, pass, batch, r.body, list, unresolved)
        run.save()
        break
      case 'unauthorized':
        run.stop = { kind: 'unauthorized' }
        break
      case 'offline':
        run.stop = { kind: 'unreachable', code: 'offline' }
        break
      case 'error':
        if (r.status === 400 || r.status === 413) {
          if (batch.length > 1) {
            run.bp.maxFiles = 1 // isolate the file the server refuses
            break
          }
          list.splice(0, 1)
          run.fail(batch[0]?.source_path ?? '', r.code, r.message)
          run.save()
        } else if (r.status === 429) {
          const info: RetryInfo = { code: r.code, status: 429 }
          if (r.retryAfterMs !== undefined) info.retryAfterMs = r.retryAfterMs
          await run.retryOrStop(info, 'rate', batch.length)
        } else run.stop = { kind: 'error', code: r.code, message: r.message }
        break
      case 'network': {
        const info: RetryInfo = { code: r.code }
        if (r.status !== undefined) info.status = r.status
        if (r.retryAfterMs !== undefined) info.retryAfterMs = r.retryAfterMs
        if (r.apiCode !== undefined) info.apiCode = r.apiCode
        const cls = retryClass(info)
        if (cls) await run.retryOrStop(info, cls, batch.length)
        else run.stop = { kind: 'unreachable', code: r.code }
        break
      }
    }
  }
  return unresolved
}

/** The per-file results of one ok answer. */
async function adrResults(
  run: ImportRun,
  pass: 1 | 2,
  batch: ImportFile[],
  body: ImportBody | null | undefined,
  list: string[],
  unresolved: string[],
): Promise<void> {
  const { ctx, counts } = run
  if (run.json) run.out(JSON.stringify(body, null, 2))
  // Only paths this batch sent are ever written (review-log-phase5 S1): a result for any other path, or a second
  // result for the same path, is a protocol error and is dropped without touching a file.
  const sent = new Map(batch.map((f) => [f.source_path, f.content]))
  const results = Array.isArray(body?.results) ? (body.results as (PushResult | ImportError)[]) : []
  let internal = false
  for (const res of results) {
    const path = res && typeof res === 'object' ? res.source_path : undefined
    if (typeof path !== 'string' || !sent.has(path)) {
      counts.errors++
      run.out('error: the server answered for a file this batch did not send; ignored')
      continue
    }
    const content = sent.get(path) as string
    sent.delete(path)
    if (isError(res)) {
      if (res.error === 'internal') {
        // nothing is wrong with the file: send it again later
        internal = true
        run.later(path, typeof res.message === 'string' ? res.message : undefined, list, pass)
        continue
      }
      run.fail(path, String(res.error), typeof res.message === 'string' ? res.message : undefined)
      continue
    }
    const problem = pushResultProblem(res)
    if (problem) {
      counts.errors++
      run.out(`error ${path}: unexpected import result (${problem}); file not changed`)
      run.set(path, 'failed', { error: 'invalid_response', message: problem })
      continue
    }
    const renumbered = validRenumber(res.renumbered)
    const codes = new Set(
      (Array.isArray(res.warnings) ? res.warnings : []).map((w) =>
        w && typeof w === 'object' ? w.code : '',
      ),
    )
    const needsSecond = pass === 1 && (renumbered !== undefined || [...codes].some((c) => SECOND_PASS.has(c)))
    const applied = await applyPushResult(ctx, 'adr', path, res, {
      muteUnresolved: needsSecond,
      sent: content,
    })
    if (applied.gone) {
      run.fail(path, 'file_moved', 'moved during the import; run the command again')
      continue
    }
    run.move(path, applied.path)
    if (pass === 1) {
      counts[res.status]++
      if (renumbered) counts.renumbered++
    }
    if (!run.json && (pass === 1 || res.status !== 'unchanged'))
      run.out(`${res.status} ${applied.path} ${res.handle} r${res.revision}`)
    for (const n of applied.notes) run.out(n)
    if (applied.edited) {
      // edited during the request: send the new content again in this run
      run.set(applied.path, pass === 1 ? 'pending' : 'edges')
      list.push(applied.path)
      continue
    }
    if (pass === 1) {
      run.set(applied.path, needsSecond ? 'edges' : 'done')
      continue
    }
    if ([...codes].some((c) => LINKS_MISSING.has(c))) {
      counts.errors++
      run.out(`warning: ${applied.path}: links were not applied; run the command again`)
      run.set(applied.path, 'edges')
    } else if (renumbered) run.set(applied.path, 'edges')
    else {
      run.set(applied.path, 'done')
      if ([...codes].some((c) => UNRESOLVED.has(c))) unresolved.push(applied.path)
    }
  }
  // a sent file without a result: like `internal`
  for (const path of sent.keys()) {
    internal = true
    run.later(path, undefined, list, pass)
  }
  if (internal) run.bp.pressure()
}

export async function cmdDocsImport(
  ctx: Ctx,
  o: { dryRun?: boolean; json?: boolean; all?: boolean },
): Promise<number> {
  const files = docFiles(ctx)
  if (o.dryRun) {
    const q = readImportQueue(ctx.root)
    const section: QueueSection = structuredClone(q.doc ?? newSection(ctx.rt.now()))
    const plan = planImport(ctx, 'doc', files, section, { all: o.all, reserveAbove: 0 })
    for (const f of plan.send) ctx.rt.out(`would import ${f}\n`)
    for (const l of plan.local) ctx.rt.out(`would not send ${l.path}: ${l.code} (${l.message})\n`)
    ctx.rt.out(`${plan.send.length} files in ${plan.send.length} request(s)\n`)
    if (plan.skipped > 0) ctx.rt.out(alreadyLine(plan.skipped))
    return 0
  }
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  const lock = takeLock(ctx)
  if (!lock) return 1
  try {
    const q = readImportQueue(ctx.root)
    const section = q.doc ?? newSection(ctx.rt.now())
    const plan = planImport(ctx, 'doc', files, section, { all: o.all, reserveAbove: 0 })
    const client = clientFor(ctx, { breaker: 'off' })
    const run = new ImportRun(ctx, 'doc', q, section, lock, client, o.json === true)
    for (const l of plan.local) {
      run.counts.errors++
      run.out(`error ${l.path}: ${l.code} (${l.message})`)
    }
    run.save()
    await docsLoop(run, [...plan.send])
    run.save()
    const c = run.counts
    ctx.rt.out(`${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.errors} errors\n`)
    if (plan.skipped > 0) ctx.rt.out(alreadyLine(plan.skipped))
    run.finishNotice(files.length)
    run.stopNotice(files.length)
    return run.exitCode()
  } finally {
    lock.release()
  }
}

/** One `POST /api/push` per file (no second pass for docs). */
async function docsLoop(run: ImportRun, list: string[]): Promise<void> {
  const { ctx, counts } = run
  while (list.length > 0 && !run.stop) {
    const path = list[0] as string
    const content = readFileText(ctx, path)
    if (content === undefined) {
      list.shift()
      delete run.section.entries[path]
      continue
    }
    const bad = localProblem('doc', path, content, 0)
    if (bad) {
      list.shift()
      run.fail(path, bad.code, bad.message)
      continue
    }
    if (!(await run.beforeRequest())) break
    const out = await pushFile(ctx, run.client, 'doc', path, {
      noQueue: true,
      timeoutMs: importTimeoutMs(importFileBytes({ source_path: path, content }), ctx.rt.env),
      headers: DEFER_EMBEDDING,
    })
    switch (out.kind) {
      case 'pushed':
        run.bp.ok()
        list.shift()
        counts[out.result.status]++
        if (run.json) run.out(JSON.stringify(out.result))
        else run.out(`${out.result.status} ${out.path} ${out.result.handle} r${out.result.revision}`)
        for (const n of out.notes) run.out(n)
        run.move(path, out.path)
        if (out.edited) {
          // edited during the request: send the new content again in this run
          run.set(out.path, 'pending')
          list.push(out.path)
        } else run.set(out.path, 'done')
        break
      case 'queued': {
        const info: RetryInfo = { code: out.code }
        if (out.status !== undefined) info.status = out.status
        if (out.retryAfterMs !== undefined) info.retryAfterMs = out.retryAfterMs
        if (out.apiCode !== undefined) info.apiCode = out.apiCode
        const cls = retryClass(info)
        if (cls) await run.retryOrStop(info, cls, 1)
        else run.stop = { kind: 'unreachable', code: out.code }
        break
      }
      case 'unauthorized':
        run.stop = { kind: 'unauthorized' }
        break
      case 'missing':
        list.shift()
        delete run.section.entries[path]
        break
      case 'error':
        if (out.status === 429) {
          // back-pressure, not a per-file error: wait and send the same file again
          const info: RetryInfo = { code: out.code, status: 429 }
          if (out.retryAfterMs !== undefined) info.retryAfterMs = out.retryAfterMs
          await run.retryOrStop(info, 'rate', 1)
          break
        }
        if (out.status === 403 || out.status === 404) {
          run.stop = { kind: 'error', code: out.code, message: out.message }
          break
        }
        run.bp.ok()
        list.shift()
        counts.errors++
        run.out(`error ${path}: ${describe(out)}`)
        run.set(path, 'failed', { error: out.code, ...(out.message ? { message: out.message } : {}) })
        break
      default:
        // conflict, already_drafted: the server answered; this file is not imported
        run.bp.ok()
        list.shift()
        counts.errors++
        run.out(`error ${path}: ${describe(out)}`)
        run.set(path, 'failed', { error: out.kind })
    }
    run.save()
  }
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
