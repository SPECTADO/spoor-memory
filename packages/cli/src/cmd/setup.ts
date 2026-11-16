/** `spoor init` and `spoor login` (cli-and-hooks.md sections 4.1, 4.9, 7; auth-and-security.md section 6). */
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkInstallBlockValues,
  INSTALL_GITIGNORE_LINES,
  INSTALL_VERSION_RE,
  type InstallBlockValues,
  mcpJsonBlock,
  mergeAgentsMd,
  mergeClaudeMd,
  settingsJsonBlock,
} from '@spoor/shared'
import { normalizeServer, PROJECT_MARKER } from '../config.js'
import { api, type Ctx, clientFor, makeCtx, notInitialized, USER_AGENT, VERSION } from '../ctx.js'
import { InvalidJsonFile, readJsonObject, readText, repoFileTarget, writeAtomic } from '../fsutil.js'
import { git, gitPrefix, gitTopLevel, isTracked } from '../git.js'
import {
  deleteLocalMemory,
  fileList,
  isLocalMemoryMode,
  type LocalMemoryMode,
  syncLocalMemory,
} from '../local-memory.js'
import { localMemoryFiles } from '../mirror.js'
import {
  ignoreLinesAt,
  jsonOut,
  lineDiff,
  mergeGitignore,
  mergeLocalSettings,
  mergeMcpJson,
  mergeSettingsJson,
} from '../settings-files.js'
import { updateState } from '../state.js'
import type { WhoamiResponse } from './info.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export const GITIGNORE_LINES: string[] = [...INSTALL_GITIGNORE_LINES]

/**
 * What `spoor init` takes from the public, unauthenticated install.json: only the project slug (must be the one asked
 * for) and the server's version (a strict pattern). The blocks it writes are rendered by the CLI itself
 * (`@spoor/shared` install.ts) from its own `SPOOR_URL`, so the server cannot choose MCP servers, hook commands,
 * permissions or ignore lines for committed files (review-log-phase5 S4).
 */
function installVersion(v: unknown, slug: string): string | undefined {
  if (!isObj(v)) return undefined
  if (v.project !== undefined && v.project !== slug) return undefined
  return typeof v.version === 'string' && INSTALL_VERSION_RE.test(v.version) ? v.version : undefined
}

/** install.json `memory_exclusive`: only an explicit `false` turns the rule off (an older server sends nothing). */
function installExclusive(v: unknown): boolean {
  return !(isObj(v) && v.memory_exclusive === false)
}

interface PlannedWrite {
  path: string
  rel: string
  before: string
  after: string
  mode?: number
}

/**
 * The `.gitignore` at the git top level, and the repo root's prefix below it: lines written there get that prefix,
 * because a pattern with a slash is anchored to the directory of its `.gitignore` (deviations H11).
 */
async function gitignorePath(ctx: Ctx): Promise<{ path: string; rel: string; prefix: string }> {
  const top = (await gitTopLevel(ctx.root)) ?? ctx.root
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  if (real(top) === real(ctx.root))
    return { path: join(ctx.root, '.gitignore'), rel: '.gitignore', prefix: '' }
  const prefix = (await gitPrefix(ctx.root)) ?? ''
  return { path: join(top, '.gitignore'), rel: join(top, '.gitignore'), prefix }
}

function applyWrites(ctx: Ctx, writes: PlannedWrite[], dryRun: boolean | undefined): void {
  for (const w of writes) {
    if (w.before === w.after) {
      if (!dryRun) ctx.rt.out(`unchanged ${w.rel}\n`)
      continue
    }
    if (dryRun) {
      // settings.local.json holds the token: the diff shows only its prefix
      ctx.rt.out(lineDiff(w.rel, w.before, w.after).replace(/\b(sprs?_[A-Za-z0-9]{4})[A-Za-z0-9_-]+/g, '$1…'))
      continue
    }
    writeAtomic(w.path, w.after, w.mode)
    ctx.rt.out(`${w.before === '' ? 'created' : 'updated'} ${w.rel}\n`)
  }
}

/**
 * `spoor init`: fetch the public install.json and merge `.mcp.json`, `.claude/settings.json`, `.gitignore`, the
 * `AGENTS.md` block, the `CLAUDE.md` import and (logged-in users) `autoMemoryEnabled` in `settings.local.json`.
 * Every file is read and merged first; invalid JSON anywhere aborts with exit 1 before anything is written.
 * It also writes `spoor.config.json`, the committed marker of a project set up for Spoor, and settles what happens to
 * memory files from before Spoor (`localMemoryStep`).
 */
export async function cmdInit(
  ctx: Ctx,
  o: { dryRun?: boolean; localMemory?: string; recall?: string },
): Promise<number> {
  if (ctx.home) {
    ctx.rt.err(`${notInitialized(ctx)}\n`)
    return 1
  }
  if (o.localMemory !== undefined && !isLocalMemoryMode(o.localMemory)) {
    ctx.rt.err('spoor: --local-memory must be sync or delete\n')
    return 1
  }
  if (o.recall !== undefined && o.recall !== 'on' && o.recall !== 'off') {
    ctx.rt.err('spoor: --recall must be on or off\n')
    return 1
  }
  // prompt recall (ADR-0037): the flag, else what spoor.config.json says
  const recall = o.recall === undefined ? ctx.repo.recall.enabled : o.recall === 'on'
  if (!ctx.server || !ctx.project) {
    ctx.rt.err(
      'spoor: SPOOR_URL and SPOOR_PROJECT are not set; run spoor login, or pass --server and --project\n',
    )
    return 1
  }
  const r = await api<unknown>(
    clientFor(ctx, { breaker: 'off', timeoutMs: 10_000, token: null }),
    'GET',
    `/p/${encodeURIComponent(ctx.project)}/install.json`,
  )
  if (r.kind !== 'ok') {
    if (r.kind === 'error' && r.status === 404) {
      ctx.rt.err(`spoor: project "${ctx.project}" not found on ${ctx.server}\n`)
      return 1
    }
    ctx.rt.err(
      r.kind === 'error'
        ? `spoor: install.json: ${r.code}${r.message ? `: ${r.message}` : ''}\n`
        : `spoor: server unreachable (${r.kind === 'network' ? r.code : r.kind} ${ctx.server})\n`,
    )
    return r.kind === 'error' ? 1 : 3
  }
  const version = installVersion(r.body, ctx.project)
  let values: InstallBlockValues | undefined
  try {
    if (version)
      values = checkInstallBlockValues({ server: normalizeServer(ctx.server), slug: ctx.project, version })
  } catch {
    values = undefined
  }
  if (!values) {
    ctx.rt.err(
      'spoor: install.json from the server has an unexpected shape, or SPOOR_URL / SPOOR_PROJECT is not a plain origin and slug; nothing was written\n',
    )
    return 1
  }
  const writes: PlannedWrite[] = []
  try {
    // the marker first: with it the project counts as set up, and teammates' `spoor login` needs no flags
    const markerPath = join(ctx.root, PROJECT_MARKER)
    const markerBefore = readText(markerPath) ?? ''
    writes.push({
      path: markerPath,
      rel: PROJECT_MARKER,
      before: markerBefore,
      after: markerAfter(markerPath, markerBefore, values, recall, ctx.repo.recall.enabled),
    })
    const mcpPath = join(ctx.root, '.mcp.json')
    const mcpBefore = readText(mcpPath) ?? ''
    const mcpAfter = mergeMcpJson(readJsonObject(mcpPath), mcpJsonBlock(values))
    writes.push({ path: mcpPath, rel: '.mcp.json', before: mcpBefore, after: sameJson(mcpBefore, mcpAfter) })

    const setPath = join(ctx.root, '.claude', 'settings.json')
    const setBefore = readText(setPath) ?? ''
    const setAfter = mergeSettingsJson(readJsonObject(setPath), settingsJsonBlock(values, { recall }))
    writes.push({
      path: setPath,
      rel: '.claude/settings.json',
      before: setBefore,
      after: sameJson(setBefore, setAfter),
    })
  } catch (e) {
    if (e instanceof InvalidJsonFile) {
      ctx.rt.err(`spoor: ${e.message}\n`)
      return 1
    }
    throw e
  }
  const gi = await gitignorePath(ctx)
  const giBefore = readText(gi.path) ?? ''
  writes.push({
    path: gi.path,
    rel: gi.rel,
    before: giBefore,
    after: mergeGitignore(giBefore, ignoreLinesAt(GITIGNORE_LINES, gi.prefix)),
  })
  const exclusive = installExclusive(r.body)
  writes.push(...agentsWrites(ctx, exclusive))
  const local = await autoMemoryWrite(ctx, exclusive)
  if (local === 'invalid') return 1
  if (local) writes.push(local)
  applyWrites(ctx, writes, o.dryRun)
  return localMemoryStep(ctx, o)
}

/**
 * `spoor.config.json` after init: created with server and project when missing, otherwise untouched, except for
 * `recall.enabled` when `--recall` changed it. Throws InvalidJsonFile for a file that does not parse.
 */
function markerAfter(
  path: string,
  before: string,
  values: InstallBlockValues,
  recall: boolean,
  stored: boolean,
): string {
  if (before === '')
    return jsonOut({
      server: values.server,
      project: values.slug,
      ...(recall ? { recall: { enabled: true } } : {}),
    })
  if (recall === stored) return before
  const cfg = readJsonObject(path)
  return jsonOut({ ...cfg, recall: { ...(isObj(cfg.recall) ? cfg.recall : {}), enabled: recall } })
}

/**
 * Memory files from before Spoor (ADR-0036). The answer is the project's (`local_memory.mode` in the committed
 * `spoor.config.json`): given by `--local-memory`, else stored, else asked on a terminal. Without an answer the files
 * are only named. `sync` then syncs them both ways, `delete` imports them into Spoor and removes them.
 */
async function localMemoryStep(ctx: Ctx, o: { dryRun?: boolean; localMemory?: string }): Promise<number> {
  const files = localMemoryFiles(ctx)
  let mode: LocalMemoryMode | undefined = isLocalMemoryMode(o.localMemory)
    ? o.localMemory
    : ctx.repo.local_memory.mode
  if (!mode && files.length === 0) return 0
  const n = files.length
  if (!mode) {
    ctx.rt.out(`Found ${n} memory ${n === 1 ? 'file' : 'files'} from before Spoor: ${fileList(files, 8)}\n`)
    if (o.dryRun || !ctx.rt.isTTY) {
      ctx.rt.out(
        'Choose what happens to them: spoor init --local-memory sync (keep them, synced with Spoor both ways) or --local-memory delete (import them into Spoor, then delete them)\n',
      )
      return 0
    }
    const answer = (
      await ctx.rt.prompt(
        '[s] keep them and sync them with Spoor, [d] import them into Spoor and delete them, [Enter] decide later: ',
      )
    )
      .trim()
      .toLowerCase()
    mode =
      answer === 's' || answer === 'sync'
        ? 'sync'
        : answer === 'd' || answer === 'delete'
          ? 'delete'
          : undefined
    if (!mode) {
      ctx.rt.out('Nothing was changed; spoor init asks again next time.\n')
      return 0
    }
  }
  if (o.dryRun) {
    if (mode !== ctx.repo.local_memory.mode)
      ctx.rt.out(`would set local_memory.mode to ${mode} in ${PROJECT_MARKER}\n`)
    for (const f of files)
      ctx.rt.out(mode === 'sync' ? `would sync ${f}\n` : `would import and delete ${f}\n`)
    return 0
  }
  if (mode !== ctx.repo.local_memory.mode) {
    const path = join(ctx.root, PROJECT_MARKER)
    let cfg: Obj
    try {
      cfg = readJsonObject(path)
    } catch (e) {
      ctx.rt.err(`spoor: ${(e as Error).message}\n`)
      return 1
    }
    const prev = isObj(cfg.local_memory) ? cfg.local_memory : {}
    writeAtomic(path, jsonOut({ ...cfg, local_memory: { ...prev, mode } }))
    ctx.rt.out(`updated ${PROJECT_MARKER} (local_memory.mode: ${mode}); commit it\n`)
    ctx.repo = { ...ctx.repo, local_memory: { ...ctx.repo.local_memory, mode } }
  }
  if (n === 0) return 0
  return mode === 'sync' ? syncLocalMemory(ctx) : deleteLocalMemory(ctx, files)
}

/**
 * The Spoor block in `AGENTS.md` and the `@AGENTS.md` import in `CLAUDE.md` (ADR-0015). A symlink is written through
 * when it stays in the repo; `CLAUDE.md` linked to `AGENTS.md` needs no import.
 */
function agentsWrites(ctx: Ctx, exclusive: boolean): PlannedWrite[] {
  const writes: PlannedWrite[] = []
  const agents = repoFileTarget(ctx.root, 'AGENTS.md')
  if (!agents) ctx.rt.err('spoor: AGENTS.md links outside the repo; not written\n')
  else {
    const before = readText(agents) ?? ''
    writes.push({ path: agents, rel: 'AGENTS.md', before, after: mergeAgentsMd(before, exclusive) })
  }
  const claude = repoFileTarget(ctx.root, 'CLAUDE.md')
  if (!claude) ctx.rt.err('spoor: CLAUDE.md links outside the repo; not written\n')
  else if (claude !== agents) {
    const before = readText(claude) ?? ''
    writes.push({ path: claude, rel: 'CLAUDE.md', before, after: mergeClaudeMd(before) })
  }
  return writes
}

/**
 * `autoMemoryEnabled: false` in this user's `.claude/settings.local.json` when the project is exclusive (ADR-0015).
 * Only a logged-in user has that file; a tracked one is never touched (login refuses it for the same reason). When the
 * project is not exclusive the key is left alone, with a hint if it is still off.
 */
async function autoMemoryWrite(ctx: Ctx, exclusive: boolean): Promise<PlannedWrite | 'invalid' | undefined> {
  const path = join(ctx.root, '.claude', 'settings.local.json')
  if (!existsSync(path) || (await isTracked(ctx.root, '.claude/settings.local.json'))) return undefined
  let local: Obj
  try {
    local = readJsonObject(path)
  } catch (e) {
    ctx.rt.err(`spoor: ${(e as Error).message}\n`)
    return 'invalid'
  }
  if (!exclusive) {
    if (local.autoMemoryEnabled === false)
      ctx.rt.out(
        'note: autoMemoryEnabled is false in .claude/settings.local.json; remove it to use Claude Code auto-memory again\n',
      )
    return undefined
  }
  const before = readText(path) ?? ''
  const after = local.autoMemoryEnabled === false ? before : jsonOut({ ...local, autoMemoryEnabled: false })
  return { path, rel: '.claude/settings.local.json', before, after, mode: 0o600 }
}

/** Keep the existing text when it already parses to the same value (no reformatting churn). */
function sameJson(before: string, after: Obj): string {
  if (before.trim() !== '') {
    try {
      if (JSON.stringify(JSON.parse(before)) === JSON.stringify(after)) return before
    } catch {
      // unreachable: the caller already parsed it
    }
  }
  return jsonOut(after)
}

const TOKEN_RE = /^sprs?_[A-Za-z0-9_-]{8,}$/
/** RFC 8628 user code as the server issues it: 8 letters, optionally `XXXX-XXXX` (api.md section 11.2). */
const USER_CODE_RE = /^[A-Z]{4}-?[A-Z]{4}$/

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

interface DeviceToken {
  access_token: string
  token_type: string
  project: string
  role: string
  token_name: string
}

function canOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

export interface LoginOpts {
  token?: string
  noBrowser?: boolean
  noInit?: boolean
  untrack?: boolean
  /** `--local-memory sync|delete`, handed to `spoor init`. */
  localMemory?: string
}

/** `spoor login`: device flow (or a pasted token), then settings.local.json, .gitignore and `spoor init`. */
export async function cmdLogin(ctx: Ctx, o: LoginOpts): Promise<number> {
  const rt = ctx.rt
  if (ctx.home) {
    rt.err(`${notInitialized(ctx)}\n`)
    return 1
  }
  if (o.noInit && !ctx.initialized) {
    rt.err(
      `spoor: ${ctx.root} is not set up for Spoor yet (no ${PROJECT_MARKER}); run spoor login without --no-init\n`,
    )
    return 1
  }
  // step 0: tracked-file guard, before any network
  const tracked: string[] = []
  if (await isTracked(ctx.root, '.claude/settings.local.json')) tracked.push('.claude/settings.local.json')
  if (await isTracked(ctx.root, '.spoor')) tracked.push('.spoor')
  if (tracked.length > 0) {
    if (o.untrack) {
      for (const t of tracked) {
        const r = await git(ctx.root, ['rm', '-r', '--cached', '--quiet', '--', t], 5000)
        if (!r.ok) {
          rt.err(`spoor: git rm --cached ${t} failed\n`)
          return 1
        }
        rt.out(`untracked ${t} (not committed; commit the removal)\n`)
      }
    } else {
      const first = tracked[0] as string
      rt.err(
        `spoor: ${first} is tracked by git, so a token written there would be committed. Run: git rm -r --cached ${tracked.join(' ')} && git commit, then spoor login again.\n`,
      )
      return 1
    }
  }
  const localPath = join(ctx.root, '.claude', 'settings.local.json')
  let local: Obj
  try {
    local = readJsonObject(localPath)
  } catch (e) {
    rt.err(`spoor: ${(e as Error).message}\n`)
    return 1
  }
  // step 1: server and project
  let server: string
  try {
    if (!ctx.cfg?.server) throw new Error('missing')
    server = normalizeServer(ctx.cfg.server.value)
  } catch {
    rt.err('spoor: SPOOR_URL is not set; run spoor login --server URL --project SLUG\n')
    return 1
  }
  const project = ctx.project
  if (!project) {
    rt.err('spoor: SPOOR_PROJECT is not set; run spoor login --server URL --project SLUG\n')
    return 1
  }
  const pub = clientFor(ctx, { breaker: 'off', timeoutMs: 10_000, token: null, server })
  const slug = encodeURIComponent(project)

  let token: string
  let expiresAt: string | null = null
  if (o.token !== undefined) {
    let t = o.token
    if (t === '-') t = (await rt.readStdin()).trim()
    if (t === '' || !TOKEN_RE.test(t)) {
      rt.err('spoor: --token needs a Spoor token (spr_… or sprs_…), or - to read it from stdin\n')
      return 1
    }
    token = t
  } else {
    const health = await api<unknown>(pub, 'GET', '/healthz')
    if (health.kind === 'network' || health.kind === 'offline') {
      rt.err(`spoor: server unreachable (${health.kind === 'network' ? health.code : 'offline'} ${server})\n`)
      return 3
    }
    const hostname = rt.hostname()
    const code = await api<DeviceCode>(pub, 'POST', `/p/${slug}/device/code`, {
      body: { client_name: `${USER_AGENT} on ${hostname}`.slice(0, 64) },
    })
    if (code.kind !== 'ok') {
      if (code.kind === 'error' && code.status === 404) {
        rt.err(`spoor: project "${project}" not found on ${server}\n`)
        return 1
      }
      rt.err(`spoor: device login failed (${code.kind === 'error' ? code.code : code.kind})\n`)
      return 3
    }
    const d = code.body
    // The approval page and the code are never taken from the answer as they are (review-log-phase5 S5, S6): the URL
    // the CLI prints and opens is its own `<server>/device`, and the code must have the 8-letter device-code shape.
    const verifyUrl = `${server}/device`
    const userCode = typeof d?.user_code === 'string' ? d.user_code : ''
    if (!USER_CODE_RE.test(userCode) || typeof d.device_code !== 'string' || d.device_code === '') {
      rt.err('spoor: device login failed (unexpected answer from the server)\n')
      return 3
    }
    const minutes = Math.max(1, Math.round((Number(d.expires_in) || 600) / 60))
    rt.out(
      `Open ${verifyUrl} and enter the code ${userCode}\nto approve project "${project}" (choose Approve read-only only if the agent should never record decisions or facts). Waiting up to ${minutes} min...\n`,
    )
    if (!o.noBrowser && canOpenBrowser(rt.env)) rt.openBrowser(verifyUrl)
    let interval = Math.max(1, d.interval || 5) * 1000
    const end = rt.now() + (d.expires_in || 600) * 1000
    let got: DeviceToken | undefined
    while (rt.now() < end) {
      await rt.sleep(interval)
      const t = await api<DeviceToken>(pub, 'POST', `/p/${slug}/device/token`, {
        body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d.device_code },
      })
      if (t.kind === 'ok') {
        got = t.body
        break
      }
      if (t.kind === 'network' || t.kind === 'offline') continue // transient: keep polling until expiry
      if (t.kind === 'error') {
        if (t.code === 'authorization_pending') continue
        if (t.code === 'slow_down') {
          const next = (t.body.details as { interval?: unknown } | undefined)?.interval
          interval = typeof next === 'number' && next > 0 ? next * 1000 : interval + 5000
          continue
        }
        if (t.code === 'access_denied') {
          rt.err('spoor: login was denied in the browser\n')
          return 3
        }
        if (t.code === 'expired_token') {
          rt.err('spoor: the code expired; run spoor login again\n')
          return 3
        }
        rt.err(`spoor: device login failed (${t.code})\n`)
        return 3
      }
      rt.err('spoor: device login failed (401)\n')
      return 3
    }
    if (!got) {
      rt.err('spoor: the code expired; run spoor login again\n')
      return 3
    }
    token = got.access_token
    expiresAt = new Date(rt.now() + 90 * 24 * 3600 * 1000).toISOString()
  }

  // step 5: prove the token, then write settings.local.json
  const who = await api<WhoamiResponse>(
    clientFor(ctx, { breaker: 'off', timeoutMs: 10_000, token, server }),
    'GET',
    `/p/${slug}/api/whoami`,
  )
  if (who.kind !== 'ok') {
    if (who.kind === 'unauthorized') rt.err(`spoor: token rejected by ${server} (401)\n`)
    else if (who.kind === 'error') rt.err(`spoor: whoami failed (${who.code})\n`)
    else rt.err(`spoor: server unreachable (${who.kind === 'network' ? who.code : 'offline'} ${server})\n`)
    return who.kind === 'error' && who.status < 500 && who.status !== 403 ? 1 : 3
  }
  const w = who.body
  if (typeof w.token?.expires_at === 'string') expiresAt = w.token.expires_at
  // whoami says null for a token without expiry (a web token created without one): remember that it never expires
  const noExpiry = w.token?.expires_at === null
  if (noExpiry) expiresAt = null
  const prevEnv = isObj(local.env) ? local.env : {}
  const previous =
    typeof prevEnv.SPOOR_TOKEN === 'string' && prevEnv.SPOOR_TOKEN !== token ? prevEnv.SPOOR_TOKEN : undefined
  try {
    local = readJsonObject(localPath) // re-read: the user may have edited it while waiting
  } catch (e) {
    rt.err(`spoor: ${(e as Error).message}\n`)
    return 1
  }
  const merged = mergeLocalSettings(local, { SPOOR_URL: server, SPOOR_PROJECT: project, SPOOR_TOKEN: token })
  writeAtomic(localPath, jsonOut(merged), 0o600)
  rt.out('wrote .claude/settings.local.json (mode 0600, never commit it)\n')
  await updateState(ctx.root, (s) => {
    s.login = {
      prefix: token.slice(0, 12),
      expires_at: expiresAt,
      at: new Date(rt.now()).toISOString(),
      ...(noExpiry ? { no_expiry: true } : {}),
      ...(typeof w.token?.role === 'string' ? { role: w.token.role } : {}),
    }
  })

  // step 6: .gitignore (reported here: init then finds it unchanged)
  const gi = await gitignorePath(ctx)
  const giBefore = readText(gi.path) ?? ''
  const giAfter = mergeGitignore(giBefore, ignoreLinesAt(GITIGNORE_LINES, gi.prefix))
  if (giAfter !== giBefore) {
    writeAtomic(gi.path, giAfter)
    rt.out(`${giBefore === '' ? 'created' : 'updated'} ${gi.rel}\n`)
  }

  // step 7: init
  let code = 0
  if (!o.noInit) {
    // a fresh context: it reads the token, server and project this login just stored
    const fresh = makeCtx(rt, {}, ctx.root)
    fresh.server = server
    fresh.project = project
    code = await cmdInit(fresh, o.localMemory !== undefined ? { localMemory: o.localMemory } : {})
  }
  // step 8
  const exp = expiresAt
    ? ` (token expires ${expiresAt.slice(0, 10)})`
    : noExpiry
      ? ' (token has no expiry)'
      : ''
  rt.out(
    `Logged in as ${w.user.label} to "${w.project.slug}" with role ${w.token.role}${exp}. Restart Claude Code, or run /mcp, to load the MCP server.\n`,
  )
  if (!o.noInit) rt.out('Next: spoor adr import && spoor docs import\n')
  if (previous)
    rt.out(
      `The previous token (${previous.slice(0, 12)}…) was not revoked. Revoke old tokens in the web UI.\n`,
    )
  return code
}

export { VERSION }
