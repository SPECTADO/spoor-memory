/**
 * Deterministic merges of the integration files (cli-and-hooks.md sections 4.1 steps 5 and 6, 4.9, 7): every
 * function is pure (old text in, new text out), keeps unrelated keys and hooks, and is idempotent.
 */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export const jsonOut = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

/** `.mcp.json`: set `mcpServers.spoor`, keep every other server and key. */
export function mergeMcpJson(existing: Obj, rendered: Obj): Obj {
  const out: Obj = { ...existing }
  const servers = isObj(existing.mcpServers) ? { ...existing.mcpServers } : {}
  const renderedServers = isObj(rendered.mcpServers) ? rendered.mcpServers : {}
  for (const [name, block] of Object.entries(renderedServers)) servers[name] = block
  out.mcpServers = servers
  return out
}

/** A hook handler that Spoor owns (recognised by `spoor hook` in its command). */
const isSpoorHandler = (h: unknown) =>
  isObj(h) && typeof h.command === 'string' && h.command.includes('spoor hook')

/**
 * `.claude/settings.json`: add the rendered `permissions.allow` entries, and per hook event replace the Spoor
 * handlers in place (first position where one was) or append the rendered groups; every other key, group and
 * handler is kept.
 */
export function mergeSettingsJson(existing: Obj, rendered: Obj): Obj {
  const out: Obj = { ...existing }
  const rPerms = isObj(rendered.permissions) ? rendered.permissions : {}
  const rAllow = Array.isArray(rPerms.allow) ? rPerms.allow : []
  if (rAllow.length > 0) {
    const perms: Obj = isObj(existing.permissions) ? { ...existing.permissions } : {}
    const allow = Array.isArray(perms.allow) ? [...perms.allow] : []
    for (const a of rAllow) if (!allow.includes(a)) allow.push(a)
    perms.allow = allow
    out.permissions = perms
  }
  const rHooks = isObj(rendered.hooks) ? rendered.hooks : {}
  if (Object.keys(rHooks).length > 0) {
    const hooks: Obj = isObj(existing.hooks) ? { ...existing.hooks } : {}
    for (const [event, groups] of Object.entries(rHooks)) {
      const newGroups = Array.isArray(groups) ? groups : []
      const old = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
      const kept: unknown[] = []
      let insertAt = -1
      for (const g of old) {
        if (!isObj(g) || !Array.isArray(g.hooks)) {
          kept.push(g)
          continue
        }
        const handlers = g.hooks as unknown[]
        if (!handlers.some(isSpoorHandler)) {
          kept.push(g)
          continue
        }
        if (insertAt < 0) insertAt = kept.length
        const rest = handlers.filter((h) => !isSpoorHandler(h))
        if (rest.length > 0) kept.push({ ...g, hooks: rest })
      }
      if (insertAt < 0) insertAt = kept.length
      kept.splice(insertAt, 0, ...newGroups)
      hooks[event] = kept
    }
    out.hooks = hooks
  }
  return out
}

/** `.claude/settings.local.json` env block written by `spoor login`. */
export function mergeLocalSettings(existing: Obj, env: Record<string, string>): Obj {
  const out: Obj = { ...existing }
  out.env = { ...(isObj(existing.env) ? existing.env : {}), ...env }
  return out
}

const normIgnore = (line: string) =>
  line
    .trim()
    .replace(/^\*\*\//, '')
    .replace(/^\//, '')
    .replace(/\/\*{1,2}$/, '/')
    .replace(/\/$/, '')

/** Append the lines that have no equivalent entry yet (`/x`, `**\/x`, `x/`, `x/*` count as equal). */
export function mergeGitignore(existing: string, lines: string[]): string {
  const have = new Set(
    existing
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#') && !l.trim().startsWith('!'))
      .map(normIgnore),
  )
  const add = lines.filter((l) => !have.has(normIgnore(l)))
  if (add.length === 0) return existing
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  return `${existing}${sep}${add.join('\n')}\n`
}

/**
 * Root-relative ignore lines for a `.gitignore` at the git top level, when the repo root is the subdirectory `prefix`
 * (`pkg/`): `.claude/settings.local.json` → `pkg/.claude/settings.local.json` (deviations H11). Blank and comment lines
 * stay as they are; a negation keeps its `!`.
 */
export function ignoreLinesAt(lines: string[], prefix: string): string[] {
  if (prefix === '') return lines
  return lines.map((l) => {
    const t = l.trim()
    if (t === '' || t.startsWith('#')) return l
    const neg = t.startsWith('!')
    const body = (neg ? t.slice(1) : t).replace(/^\//, '')
    return `${neg ? '!' : ''}${prefix}${body}`
  })
}

/** Minimal line diff (LCS) for `--dry-run`. */
export function lineDiff(path: string, before: string, after: string): string {
  if (before === after) return ''
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after.replace(/\n$/, '').split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number)
  const out = [`--- ${path}`, `+++ ${path}`]
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (
      j < m &&
      (i >= n || ((dp[i] as number[])[j + 1] as number) >= ((dp[i + 1] as number[])[j] as number))
    ) {
      out.push(`+ ${b[j]}`)
      j++
    } else {
      out.push(`- ${a[i]}`)
      i++
    }
  }
  return `${out.join('\n')}\n`
}
