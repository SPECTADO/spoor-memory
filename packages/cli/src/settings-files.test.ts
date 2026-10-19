import { describe, expect, it } from 'vitest'
import {
  lineDiff,
  mergeGitignore,
  mergeLocalSettings,
  mergeMcpJson,
  mergeSettingsJson,
} from './settings-files.js'
import { renderedSettings } from './testing/harness.js'

describe('mergeSettingsJson', () => {
  it('keeps unrelated keys, permissions and hooks, and is idempotent', () => {
    const existing = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'say hi' }] }],
      },
    }
    const once = mergeSettingsJson(existing, renderedSettings)
    expect(once.model).toBe('opus')
    expect(once.permissions).toEqual({ allow: ['Bash(ls)', 'mcp__spoor'], deny: ['Read(.env)'] })
    const hooks = once.hooks as Record<string, unknown[]>
    expect(hooks.Notification).toEqual(existing.hooks.Notification)
    expect(hooks.PostToolUse).toEqual([existing.hooks.PostToolUse[0], renderedSettings.hooks.PostToolUse[0]])
    expect(hooks.SessionStart).toEqual(renderedSettings.hooks.SessionStart)
    expect(mergeSettingsJson(once, renderedSettings)).toEqual(once)
  })

  it('replaces an older Spoor handler in place and keeps its neighbours', () => {
    const existing = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'first.sh' }] },
          {
            hooks: [
              { type: 'command', command: 'npx spoor-memory@0.0.1 spoor hook stop' },
              { type: 'command', command: 'mine.sh' },
            ],
          },
          { hooks: [{ type: 'command', command: 'last.sh' }] },
        ],
      },
    }
    const out = mergeSettingsJson(existing, renderedSettings).hooks as Record<string, unknown[]>
    expect(out.Stop).toEqual([
      existing.hooks.Stop[0],
      renderedSettings.hooks.Stop[0],
      { hooks: [{ type: 'command', command: 'mine.sh' }] },
      existing.hooks.Stop[2],
    ])
    const again = mergeSettingsJson({ hooks: out }, renderedSettings).hooks as Record<string, unknown[]>
    expect(again).toEqual(out)
  })
})

describe('mergeMcpJson', () => {
  it('sets mcpServers.spoor and keeps other servers', () => {
    const rendered = { mcpServers: { spoor: { type: 'http', url: 'https://s/p/acme/mcp' } } }
    const out = mergeMcpJson({ mcpServers: { other: { command: 'x' } }, extra: 1 }, rendered)
    expect(out).toEqual({
      mcpServers: { other: { command: 'x' }, spoor: rendered.mcpServers.spoor },
      extra: 1,
    })
    expect(mergeMcpJson(out, rendered)).toEqual(out)
  })
})

describe('mergeLocalSettings', () => {
  it('sets the env keys and keeps everything else', () => {
    const out = mergeLocalSettings(
      { env: { FOO: '1', SPOOR_TOKEN: 'old' }, permissions: { allow: ['x'] } },
      { SPOOR_TOKEN: 'new' },
    )
    expect(out).toEqual({ env: { FOO: '1', SPOOR_TOKEN: 'new' }, permissions: { allow: ['x'] } })
  })
})

describe('mergeGitignore', () => {
  const lines = ['.claude/settings.local.json', '.spoor/']
  it('appends missing lines once, adding a newline when needed', () => {
    expect(mergeGitignore('', lines)).toBe('.claude/settings.local.json\n.spoor/\n')
    expect(mergeGitignore('node_modules', lines)).toBe('node_modules\n.claude/settings.local.json\n.spoor/\n')
    const once = mergeGitignore('dist/\n', lines)
    expect(mergeGitignore(once, lines)).toBe(once)
  })
  it('treats equivalent entries as present', () => {
    expect(mergeGitignore('/.spoor\n**/.claude/settings.local.json\n', lines)).toBe(
      '/.spoor\n**/.claude/settings.local.json\n',
    )
    expect(mergeGitignore('.spoor/*\n', lines)).toBe('.spoor/*\n.claude/settings.local.json\n')
  })
})

describe('lineDiff', () => {
  it('marks added and removed lines', () => {
    expect(lineDiff('f', 'a\nb\n', 'a\nc\n')).toBe('--- f\n+++ f\n  a\n+ c\n- b\n')
    expect(lineDiff('f', 'x', 'x')).toBe('')
  })
})
