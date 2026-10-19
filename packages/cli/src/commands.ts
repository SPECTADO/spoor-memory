export interface Command {
  path: string[]
  summary: string
  usage: string
  hook?: boolean
}

export const commands: Command[] = [
  {
    path: ['login'],
    summary: 'Authenticate this repo with a Spoor server (device flow)',
    usage:
      'spoor login [--server URL] [--project SLUG] [--token <TOKEN|->] [--no-browser] [--no-init] [--untrack]',
  },
  {
    path: ['init'],
    summary: 'Write or merge .mcp.json, the .claude/settings.json hooks and .gitignore for this repo',
    usage: 'spoor init [--server URL] [--project SLUG] [--dry-run]',
  },
  {
    path: ['whoami'],
    summary: 'Show the identity, project and role of the current token',
    usage: 'spoor whoami [--json]',
  },
  {
    path: ['status'],
    summary: 'Show configuration, push conflicts, queued pushes, orphaned mirror files',
    usage: 'spoor status [--remote]',
  },
  {
    path: ['context'],
    summary: 'Print the project memory digest for the agent',
    usage: 'spoor context [--query TEXT] [--files a,b,c | --git] [--budget N] [--no-shared] [--json]',
  },
  {
    path: ['adr', 'import'],
    summary: 'One-time push of existing ADR files to Spoor',
    usage: 'spoor adr import [--dir docs/adr] [--dry-run] [--json]',
  },
  { path: ['adr', 'push'], summary: 'Push one ADR file to Spoor', usage: 'spoor adr push <file> [--force]' },
  {
    path: ['adr', 'draft'],
    summary: 'Draft ADR files from decision memories',
    usage: 'spoor adr draft [--since ISO] [--max N] [--dry-run] [--session ID] [--background]',
  },
  {
    path: ['docs', 'import'],
    summary: 'One-time push of repo docs to Spoor',
    usage: 'spoor docs import [--dry-run] [--json]',
  },
  { path: ['docs', 'push'], summary: 'Push one doc file to Spoor', usage: 'spoor docs push <file>' },
  {
    path: ['hook', 'session-start'],
    summary: 'Claude Code SessionStart hook (always exits 0)',
    usage: 'spoor hook session-start',
    hook: true,
  },
  {
    path: ['hook', 'stop'],
    summary: 'Claude Code Stop hook (always exits 0)',
    usage: 'spoor hook stop',
    hook: true,
  },
  {
    path: ['hook', 'post-tool-use'],
    summary: 'Claude Code PostToolUse hook (always exits 0)',
    usage: 'spoor hook post-tool-use',
    hook: true,
  },
]

export function helpText(): string {
  const w = Math.max(...commands.map((c) => c.path.join(' ').length))
  const lines = commands.map((c) => `  ${c.path.join(' ').padEnd(w)}  ${c.summary}`)
  return [
    'spoor: Spoor memory CLI',
    '',
    'Usage: spoor <command> [options]',
    '',
    'Commands:',
    ...lines,
    '',
    'Global flags: --server URL  --project SLUG  --token TOKEN  --strict  --quiet  --help  --version',
    '',
  ].join('\n')
}

export function commandHelp(c: Command): string {
  return `${c.usage}\n\n${c.summary}\n`
}

export function findCommand(args: string[]): Command | undefined {
  return commands.find((c) => c.path.every((p, i) => args[i] === p))
}
