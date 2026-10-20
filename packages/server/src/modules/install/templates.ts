/**
 * The install doc and `install.json` (api.md sections 11.1 and 11.1a, cli-and-hooks.md sections 7 and 9,
 * deviations I35, I39, D7). Pure functions of five values only: the server origin, the project slug, the
 * server's version (= the CLI version to install, pinned in the `npx` fallback), the project's default
 * digest budget and its `memory.exclusive` setting (ADR-0015). No project name, no token, no per-user data: the page is public. Every value is checked
 * against a strict pattern before it is rendered, so nothing a caller controls can break out of a code
 * span, a fence or a JSON string.
 */

import {
  agentsMdBlock,
  checkInstallBlockValues,
  INSTALL_GITIGNORE_LINES,
  isReleaseVersion,
  mcpJsonBlock,
  settingsJsonBlock,
} from '@spoor/shared'

export interface InstallValues {
  /** `SPOOR_PUBLIC_URL` origin, e.g. `https://spoor.example.com` (no trailing slash). */
  server: string
  slug: string
  version: string
  budget: number
  /** `memory.exclusive` (default true): picks the AGENTS.md block variant `spoor init` writes. */
  memoryExclusive?: boolean
}

/** Throws on a value that is not safe to render (a programming or configuration error, never user input). */
export function checkValues(v: InstallValues): InstallValues {
  checkInstallBlockValues(v)
  if (!Number.isInteger(v.budget) || v.budget < 1 || v.budget > 100_000)
    throw new Error('install template: invalid budget')
  return v
}

/** `SPOOR_TOKEN_<SLUG>`: the slug upper-cased, `-` → `_` (cli-and-hooks.md section 9 item 11). */
export function tokenEnvVar(slug: string): string {
  return `SPOOR_TOKEN_${slug.toUpperCase().replace(/-/g, '_')}`
}

/** The host for the `WebFetch(domain:…)` permission hint (no port). */
export function hostOf(server: string): string {
  return new URL(server).hostname
}

/** cli-and-hooks.md section 7.1: the `.mcp.json` block (rendered by @spoor/shared, the same code `spoor init` runs). */
export function mcpJson(v: InstallValues) {
  return mcpJsonBlock(checkValues(v))
}

/** cli-and-hooks.md section 7.2: the `.claude/settings.json` block (merged by `spoor init`). */
export function settingsJson(v: InstallValues) {
  return settingsJsonBlock(checkValues(v))
}

/** cli-and-hooks.md section 7.4. */
export const GITIGNORE_LINES = INSTALL_GITIGNORE_LINES

/** cli-and-hooks.md section 7.3, with the token as the placeholder `<paste token>` (never a real one). */
export function settingsLocalJson(v: InstallValues) {
  const { server, slug } = checkValues(v)
  return { env: { SPOOR_URL: server, SPOOR_PROJECT: slug, SPOOR_TOKEN: '<paste token>' } }
}

/** `GET /p/:slug/install.json` (api.md section 11.1a). */
export function renderInstallJson(v: InstallValues) {
  const { server, slug, version } = checkValues(v)
  return {
    version,
    server,
    project: slug,
    memory_exclusive: v.memoryExclusive ?? true,
    mcp_json: mcpJson(v),
    settings_json: settingsJson(v),
    gitignore: [...GITIGNORE_LINES],
  }
}

const FENCE = '```'
const block = (lang: string, body: string) => [`${FENCE}${lang}`, body, FENCE]
const json = (x: unknown) => JSON.stringify(x, null, 2)

/** `GET /p/:slug/install.md` (api.md section 11.1, outline in cli-and-hooks.md section 9). */
export function renderInstallMd(v: InstallValues): string {
  const { server, slug, version, budget } = checkValues(v)
  const url = `${server}/p/${slug}`
  const env = tokenEnvVar(slug)
  const lines: string[] = [
    '# Spoor memory: set up this repository',
    '',
    'You are setting up Spoor memory for this repository. Run the commands in order and never write a token into a committed file.',
    '',
    `- Server: ${server}`,
    `- Project: \`${slug}\``,
    `- CLI version: \`${version}\``,
    '',
    `Fetch this page with \`curl -s ${url}/install.md\`, which gives the exact bytes. WebFetch works for public hosts but fails on \`localhost\` and on LAN hosts without a dot; its permission rule is \`WebFetch(domain:${hostOf(server)})\`.`,
    '',
    '## 1. Prerequisites',
    '',
    '- Claude Code 2.1.302 or later',
    '- Node 22 or later',
    '- A git repository; run every command from its root',
    `- A Spoor account with a role on project \`${slug}\``,
    '',
    '## 2. Install the CLI',
    '',
    ...(isReleaseVersion(version)
      ? block('sh', `npm i -g spoor-memory@${version}`)
      : [
          `This server is a development build (version \`${version}\`), so its CLI is not on npm. Build and install it from a checkout of the Spoor source at the same version (needs pnpm):`,
          '',
          ...block('sh', 'pnpm install\npnpm --filter "spoor-memory..." build\nnpm i -g ./packages/cli'),
        ]),
    '',
    'Install it globally: the committed hook commands look for `spoor` on the PATH.',
    '',
    '## 3. Log in and set up the repo',
    '',
    ...block('sh', `spoor login --server ${server} --project ${slug} --no-browser`),
    '',
    'Run it in the background or with a 10-minute timeout. It prints a URL and a code: tell the user to open the URL, type the code shown, and press **Approve** (**Approve read-only** only for an agent that should never record decisions or facts). Never approve it yourself.',
    '',
    'It writes `.claude/settings.local.json` (holds the token, never committed), adds that file and `.spoor/` to `.gitignore`, and runs `spoor init`, which writes or merges `.mcp.json`, `.claude/settings.json`, the Spoor block in `AGENTS.md` and an `@AGENTS.md` import in `CLAUDE.md`.',
    '',
    'If it stops because `.claude/settings.local.json` is tracked by git, show the user the `git rm --cached` command it printed and ask before running it.',
    '',
    '**Manual path** (no browser on this machine, or the user prefers it): the user creates a token in the Spoor web UI (Project → Tokens), then runs:',
    '',
    ...block(
      'sh',
      `printf '%s' "<paste token>" | spoor login --token - --server ${server} --project ${slug}`,
    ),
    '',
    '**Repo already set up** (`.mcp.json` and the hooks are committed): steps 2, 3 and 7 are all a teammate needs.',
    '',
    '## 4. Import existing decisions and docs',
    '',
    ...block('sh', 'spoor adr import\nspoor docs import'),
    '',
    'Both are safe to repeat, also by several teammates. ADR files get a `spoor_id` line in their frontmatter; the user should commit that change.',
    '',
    '## 5. Verify the CLI',
    '',
    `- \`spoor status --remote\` prints the project, the role and the token expiry.`,
    `- \`spoor context --git\` prints a digest (about ${budget} tokens by default).`,
    '',
    '## 6. Commit',
    '',
    'Commit `.mcp.json`, `.claude/settings.json`, the ADR files and, if you created one, `spoor.config.json`. Never commit `.claude/settings.local.json` or `.spoor/`.',
    '',
    '## 7. Restart and approve',
    '',
    'Ask the user to restart Claude Code and approve the project MCP server `spoor` when asked (`/mcp` lists it as connected). After the restart, call `spoor_context` to verify.',
    '',
    '## 8. Day to day',
    '',
    '- The digest arrives at session start.',
    '- Call `spoor_search` before answering from memory.',
    '- Record with `spoor_remember` (facts) and `spoor_decide` (decisions); the Stop hook may remind you once per session.',
    '- ADRs drafted from decisions appear in `docs/adr/` as `proposed` and wait for a human to accept them.',
    '- ADR or doc edits made outside the Write/Edit tools are pushed at the next session start, or with `spoor adr push <file>` / `spoor docs push <file>`.',
    '',
    '## 9. Reference blocks',
    '',
    'For humans and for setups without the CLI. `spoor init` writes these for you; write them by hand only when the CLI cannot be installed.',
    '',
    '`.mcp.json` (committed; spoor init writes this for you):',
    '',
    ...block('json', json(mcpJson(v))),
    '',
    '`.claude/settings.json` (committed, merged into an existing file; spoor init writes this for you):',
    '',
    ...block('json', json(settingsJson(v))),
    '',
    '`.claude/settings.local.json` (never committed; spoor login writes this for you):',
    '',
    ...block('json', json(settingsLocalJson(v))),
    '',
    '`.gitignore` additions:',
    '',
    ...block('', GITIGNORE_LINES.join('\n')),
    '',
    '## 10. Other MCP clients (Cursor, Codex, Gemini CLI)',
    '',
    `Endpoint \`${url}/mcp\`, header \`Authorization: Bearer <token>\`, Streamable HTTP, nine tools. A token belongs to one user and one project, so each project gets its own environment variable, here \`${env}\`, filled from the web UI (Project → Tokens) and never written into a file in git. Prefer project-scoped client config files. File locations and key names were checked against each tool's docs in October 2026.`,
    '',
    `- Cursor, \`.cursor/mcp.json\`: \`{"mcpServers":{"spoor":{"url":"${url}/mcp","headers":{"Authorization":"Bearer \${env:${env}}"}}}}\``,
    `- Codex, \`.codex/config.toml\` in the repo (read for trusted projects only) or \`~/.codex/config.toml\` (one table per project): \`[mcp_servers.spoor-${slug}]\` with \`url = "${url}/mcp"\` and \`bearer_token_env_var = "${env}"\``,
    `- Gemini CLI, \`.gemini/settings.json\`: \`{"mcpServers":{"spoor":{"httpUrl":"${url}/mcp","headers":{"Authorization":"Bearer $${env}"}}}}\``,
    '',
    "These clients run no hooks. `spoor init` writes this block into `AGENTS.md`; without the CLI, add it there (or to the client's rules file) yourself:",
    '',
    ...block('markdown', agentsMdBlock(v.memoryExclusive ?? true)),
    '',
    `ADR mirroring and drafting from those clients is manual: \`spoor adr draft\` (drafts your undrafted decisions of the last 14 days), \`spoor adr push <file>\` or \`spoor adr import\`. The CLI needs the server, the project and the token, so for those runs export \`SPOOR_URL=${server} SPOOR_PROJECT=${slug} SPOOR_TOKEN=$${env}\` (or commit a \`spoor.config.json\` with \`{"server":"${server}","project":"${slug}"}\` and export only the token). \`spoor adr draft\` runs \`claude -p --model haiku\` by default; without Claude Code set \`SPOOR_DRAFT_CMD\` (or \`draft.command\` in \`spoor.config.json\`) to another model command, otherwise every draft is the fallback template.`,
    '',
    '## 11. Troubleshooting',
    '',
    '| symptom | cause and fix |',
    '|---|---|',
    '| `401 invalid_token` | the token was revoked, expired (device tokens last 90 days) or belongs to another project: run `spoor login` |',
    '| `server unreachable` | check `SPOOR_URL` in `.claude/settings.local.json` |',
    '| the digest is empty | the project has no items yet |',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text of the troubleshooting table
    '| `/mcp` shows `${SPOOR_TOKEN}` unresolved or the `spoor` server fails with 401 | `.claude/settings.local.json` has no `SPOOR_TOKEN` (run `spoor login`), or Claude Code was not restarted after login |',
    "| the `spoor` tools ask for permission, or `claude -p` denies them | Claude Code applies the committed `mcp__spoor` rule only after the folder's trust dialog was accepted: run `claude` here once and accept it, or add `mcp__spoor` to `permissions.allow` in `.claude/settings.local.json` |",
    '| "file not pushed because it was edited in the Spoor web UI" | a human decides; see `spoor status` |',
    '',
  ]
  return lines.join('\n')
}
