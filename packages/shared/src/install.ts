/**
 * The repo integration blocks (cli-and-hooks.md section 7): `.mcp.json`, `.claude/settings.json` and the `.gitignore`
 * lines. The server renders them into install.md / install.json, and `spoor init` renders the same blocks itself from
 * its own `SPOOR_URL`, the project slug and the server's version, so a compromised server (or a man in the middle of a
 * plain-http connection) cannot make `init` write other MCP servers, hook commands, permissions or ignore lines into
 * committed files (review-log-phase5 S4). Every value is checked against a strict pattern before it is rendered.
 */

export interface InstallBlockValues {
  /** Origin, e.g. `https://spoor.example.com` (no trailing slash, no path). */
  server: string
  slug: string
  /** The server's version: the CLI version the SessionStart `npx` fallback pins. */
  version: string
}

export const INSTALL_ORIGIN_RE = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/
export const INSTALL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const INSTALL_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** Throws on a value that is not safe to render. */
export function checkInstallBlockValues<T extends InstallBlockValues>(v: T): T {
  if (!INSTALL_ORIGIN_RE.test(v.server)) throw new Error('install template: server must be an http(s) origin')
  if (!INSTALL_SLUG_RE.test(v.slug)) throw new Error('install template: invalid project slug')
  if (!INSTALL_VERSION_RE.test(v.version)) throw new Error('install template: invalid version')
  return v
}

/**
 * A version published to npm: `x.y.z` or `x.y.z-pre`, never the `0.0.0` of a source build. Only such a version gets
 * the SessionStart `npx` fallback; a development server renders `exit 0` instead, so a session start never asks the
 * public registry for a version that was never published (review-log-phase5 A1).
 */
export function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version) && !/^0\.0\.0(?:-|$)/.test(version)
}

/** The hook command: the CLI on PATH, else the fallback. */
export const spoorHookCommand = (sub: string, fallback: string) =>
  `command -v spoor >/dev/null 2>&1 && exec spoor hook ${sub} || ${fallback}`

/** cli-and-hooks.md section 7.1: the `.mcp.json` block. Only the token is a variable. */
export function mcpJsonBlock(v: InstallBlockValues) {
  const { server, slug } = checkInstallBlockValues(v)
  return {
    mcpServers: {
      spoor: {
        type: 'http',
        url: `${server}/p/${slug}/mcp`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands ${SPOOR_TOKEN}, not JS
        headers: { Authorization: 'Bearer ${SPOOR_TOKEN}' },
        alwaysLoad: true,
      },
    },
  }
}

/** cli-and-hooks.md section 7.2: the `.claude/settings.json` block (merged by `spoor init`). */
export function settingsJsonBlock(v: InstallBlockValues) {
  const { version } = checkInstallBlockValues(v)
  const sessionFallback = isReleaseVersion(version)
    ? `exec npx --yes --prefer-offline spoor-memory@${version} hook session-start`
    : 'exit 0'
  return {
    permissions: { allow: ['mcp__spoor'] },
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command', timeout: 15, command: spoorHookCommand('session-start', sessionFallback) },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', timeout: 10, command: spoorHookCommand('post-tool-use', 'exit 0') }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', timeout: 15, command: spoorHookCommand('stop', 'exit 0') }] }],
    },
  }
}

/** cli-and-hooks.md section 7.4. */
export const INSTALL_GITIGNORE_LINES = ['.claude/settings.local.json', '.spoor/'] as const
