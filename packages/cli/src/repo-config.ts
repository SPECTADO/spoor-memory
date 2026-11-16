/**
 * `spoor.config.json` (committed, optional; cli-and-hooks.md section 2). Every key is optional; unknown keys are an
 * error. The token is never read from this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const DEFAULT_DRAFT_COMMAND = [
  'claude',
  '-p',
  '--model',
  'haiku',
  '--safe-mode',
  '--no-session-persistence',
  '--tools',
  '',
  '--output-format',
  'json',
]

/** Where memory files of other tools usually live in a repo (ADR-0036); `local_memory.paths` replaces the list. */
export const LOCAL_MEMORY_DEFAULT_PATHS = [
  'MEMORY.md',
  '.memory/**',
  'memory-bank/**',
  '.claude/memory/**',
  '.cursor/memory/**',
]

const repoConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  server: z.string().optional(),
  project: z.string().optional(),
  adr_dir: z.string().min(1).default('docs/adr'),
  docs: z
    .strictObject({
      include: z.array(z.string().min(1)).default(['ARCHITECTURE.md', 'GLOSSARY.md', 'docs/*.md']),
      exclude: z.array(z.string().min(1)).default(['docs/adr/**']),
      write_back: z.boolean().default(false),
    })
    .prefault({}),
  draft: z
    .strictObject({
      enabled: z.boolean().default(true),
      command: z.array(z.string()).min(1).default(DEFAULT_DRAFT_COMMAND),
      timeout_s: z.number().positive().max(600).default(60),
      max_per_run: z.number().int().min(1).max(20).default(2),
      deadline_s: z.number().positive().max(1800).default(120),
      in_ci: z.boolean().default(false),
    })
    .prefault({}),
  context: z
    .strictObject({
      max_tokens: z.number().int().min(200).max(8000).default(2500),
      max_files: z.number().int().min(1).max(200).default(80),
    })
    .prefault({}),
  /**
   * Prompt recall (ADR-0037): the UserPromptSubmit hook shows the few memory items that clearly match what the user
   * just asked. Off by default; `spoor init --recall on` turns it on and installs the hook. `min_cos` overrides the
   * server's floor for the project's embedding model; `min_chars` skips short prompts.
   */
  recall: z
    .strictObject({
      enabled: z.boolean().default(false),
      max_items: z.number().int().min(1).max(5).default(3),
      min_chars: z.number().int().min(1).max(500).default(24),
      min_cos: z.number().min(0).max(1).optional(),
    })
    .prefault({}),
  /**
   * Memory files that were in the repo before Spoor (ADR-0036). `mode` is the team's answer to `spoor init`'s
   * question: `sync` keeps them and syncs them with Spoor both ways, `delete` imports them and removes them; unset
   * means nobody answered yet.
   */
  local_memory: z
    .strictObject({
      mode: z.enum(['sync', 'delete']).optional(),
      paths: z.array(z.string().min(1)).default(LOCAL_MEMORY_DEFAULT_PATHS),
    })
    .prefault({}),
})

export type RepoConfig = z.output<typeof repoConfigSchema>

export const DEFAULT_REPO_CONFIG: RepoConfig = repoConfigSchema.parse({})

export interface LoadedRepoConfig {
  config: RepoConfig
  /** Set when the file exists but is invalid; callers fall back to the defaults (hooks) or exit 1. */
  error?: string
}

export function loadRepoConfig(root: string): LoadedRepoConfig {
  let text: string
  try {
    text = readFileSync(join(root, 'spoor.config.json'), 'utf8')
  } catch {
    return { config: DEFAULT_REPO_CONFIG }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: DEFAULT_REPO_CONFIG, error: 'spoor.config.json is not valid JSON' }
  }
  const r = repoConfigSchema.safeParse(raw)
  if (!r.success) {
    const issue = r.error.issues[0]
    const where = issue?.path.join('.') || '(root)'
    return {
      config: DEFAULT_REPO_CONFIG,
      error: `spoor.config.json: ${where}: ${issue?.message ?? 'invalid'}`,
    }
  }
  const config = r.data
  config.adr_dir = config.adr_dir.replace(/^\.\//, '').replace(/\/+$/, '')
  return { config }
}
