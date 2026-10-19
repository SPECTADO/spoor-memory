import { describe, expect, it } from 'vitest'
import {
  checkValues,
  hostOf,
  type InstallValues,
  renderInstallJson,
  renderInstallMd,
  tokenEnvVar,
} from './templates.js'

const V: InstallValues = {
  server: 'https://spoor.example.com',
  slug: 'acme-web',
  version: '0.1.0',
  budget: 1500,
}

describe('install.json (cli-and-hooks.md 7.1, 7.2, 7.4)', () => {
  it('renders exactly the documented blocks with the literal URL, slug and version', () => {
    expect(renderInstallJson({ ...V, slug: 'acme' })).toEqual({
      version: '0.1.0',
      server: 'https://spoor.example.com',
      project: 'acme',
      mcp_json: {
        mcpServers: {
          spoor: {
            type: 'http',
            url: 'https://spoor.example.com/p/acme/mcp',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal the harness expands
            headers: { Authorization: 'Bearer ${SPOOR_TOKEN}' },
            alwaysLoad: true,
          },
        },
      },
      settings_json: {
        permissions: { allow: ['mcp__spoor'] },
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  timeout: 15,
                  command:
                    'command -v spoor >/dev/null 2>&1 && exec spoor hook session-start || exec npx --yes --prefer-offline spoor-memory@0.1.0 hook session-start',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                {
                  type: 'command',
                  timeout: 10,
                  command: 'command -v spoor >/dev/null 2>&1 && exec spoor hook post-tool-use || exit 0',
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  timeout: 15,
                  command: 'command -v spoor >/dev/null 2>&1 && exec spoor hook stop || exit 0',
                },
              ],
            },
          ],
        },
      },
      gitignore: ['.claude/settings.local.json', '.spoor/'],
    })
  })
})

describe('install.md (cli-and-hooks.md 9)', () => {
  const md = renderInstallMd(V)

  it('is secret-free and carries no token shape, only the placeholder', () => {
    expect(md).not.toMatch(/sprs?_/)
    expect(md).toContain('<paste token>')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text of the page
    expect(md).toContain('${SPOOR_TOKEN}')
  })

  it('names the server, slug, version (also in the npx fallback) and budget', () => {
    expect(md).toContain('spoor login --server https://spoor.example.com --project acme-web --no-browser')
    expect(md).toContain('npm i -g spoor-memory@0.1.0')
    expect(md).toContain('spoor-memory@0.1.0 hook session-start')
    expect(md).toContain('about 1500 tokens')
    expect(md).toContain('"url": "https://spoor.example.com/p/acme-web/mcp"')
  })

  it('offers curl first and WebFetch second, with the domain permission hint', () => {
    const curl = md.indexOf('curl -s https://spoor.example.com/p/acme-web/install.md')
    const webfetch = md.indexOf('WebFetch')
    expect(curl).toBeGreaterThan(0)
    expect(webfetch).toBeGreaterThan(curl)
    expect(md).toContain('WebFetch(domain:spoor.example.com)')
  })

  it('has the generic-MCP section with one SPOOR_TOKEN_<SLUG> variable per project', () => {
    expect(tokenEnvVar('acme-web')).toBe('SPOOR_TOKEN_ACME_WEB')
    expect(md).toContain('## 10. Other MCP clients (Cursor, Codex, Gemini CLI)')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's own expansion syntax
    expect(md).toContain('"Authorization":"Bearer ${env:SPOOR_TOKEN_ACME_WEB}"')
    expect(md).toContain('[mcp_servers.spoor-acme-web]')
    expect(md).toContain('bearer_token_env_var = "SPOOR_TOKEN_ACME_WEB"')
    expect(md).toContain('"httpUrl":"https://spoor.example.com/p/acme-web/mcp"')
    expect(md).toContain('"Authorization":"Bearer $SPOOR_TOKEN_ACME_WEB"')
    // the CLI needs all three values for manual runs (review-log-phase5 A6)
    expect(md).toContain(
      'export `SPOOR_URL=https://spoor.example.com SPOOR_PROJECT=acme-web SPOOR_TOKEN=$SPOOR_TOKEN_ACME_WEB`',
    )
    expect(md).toContain('set `SPOOR_DRAFT_CMD`')
    // checked against the vendors' docs (docs/design/harness-verification.md section 1)
    expect(md).toContain(
      '`.codex/config.toml` in the repo (read for trusted projects only) or `~/.codex/config.toml`',
    )
    expect(md).not.toContain('Check the file locations and key names')
  })

  it('explains the trust gate on the committed mcp__spoor permission (harness-verified)', () => {
    expect(md).toContain('the `spoor` tools ask for permission, or `claude -p` denies them')
    expect(md).toContain('add `mcp__spoor` to `permissions.allow` in `.claude/settings.local.json`')
    // an unresolved ${SPOOR_TOKEN} is a missing variable, not an untrusted folder (expansion works untrusted)
    expect(md).toContain('`.claude/settings.local.json` has no `SPOOR_TOKEN` (run `spoor login`)')
  })

  it('keeps the section order of the outline: everything the CLI does comes before the restart', () => {
    const order = [
      'Prerequisites',
      'Install the CLI',
      'Log in and set up the repo',
      'Import existing decisions and docs',
      'Verify the CLI',
      'Commit',
      'Restart and approve',
      'Day to day',
      'Reference blocks',
      'Other MCP clients',
      'Troubleshooting',
    ].map((h) => md.indexOf(h))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('offers no dev-dependency install: the hooks only look for spoor on the PATH (review-log-phase5 D4)', () => {
    expect(md).not.toContain('npm i -D')
    expect(md).toContain('`spoor status --remote` prints the project, the role and the token expiry')
    expect(md).toContain('After the restart, call `spoor_context` to verify.')
  })

  it('a development server (0.0.0) explains the source install and renders no npx fallback (D2, A1)', () => {
    const dev = renderInstallMd({ ...V, version: '0.0.0' })
    expect(dev).not.toContain('npm i -g spoor-memory@')
    expect(dev).not.toContain('npx')
    expect(dev).toContain('npm i -g ./packages/cli')
    expect(dev).toContain('command -v spoor >/dev/null 2>&1 && exec spoor hook session-start || exit 0')
    const json = renderInstallJson({ ...V, version: '0.0.0' })
    expect(JSON.stringify(json)).not.toContain('npx')
  })

  it('renders deterministically and only from its four values', () => {
    expect(renderInstallMd(V)).toBe(md)
    expect(renderInstallMd({ ...V, budget: 2000 })).not.toBe(md)
  })
})

describe('value checks', () => {
  it('refuse anything that could break out of a code span, fence or JSON string', () => {
    expect(() => checkValues({ ...V, server: 'https://x.example.com/`rm -rf`' })).toThrow()
    expect(() => checkValues({ ...V, server: 'javascript:alert(1)' })).toThrow()
    expect(() => checkValues({ ...V, server: 'https://x.example.com/' })).toThrow()
    expect(() => checkValues({ ...V, slug: 'Acme' })).toThrow()
    expect(() => checkValues({ ...V, slug: 'a`b' })).toThrow()
    expect(() => checkValues({ ...V, slug: '_shared' })).toThrow()
    expect(() => checkValues({ ...V, version: '0.1.0; rm -rf /' })).toThrow()
    expect(() => checkValues({ ...V, budget: 1.5 })).toThrow()
    expect(checkValues({ ...V, server: 'http://localhost:3000' })).toBeTruthy()
    expect(checkValues({ ...V, server: 'http://[::1]:3000' })).toBeTruthy()
    expect(hostOf('http://localhost:3000')).toBe('localhost')
  })
})
