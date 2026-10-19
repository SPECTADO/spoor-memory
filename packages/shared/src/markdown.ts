/**
 * Markdown files with YAML frontmatter (data-model.md section 5; auth-and-security.md section 9): the ONE
 * splitter and the ONE serializer, used by the server's push, export and import and by the SPA. `yaml`
 * runs with the core schema (dates stay strings), `maxAliasCount: 20`, unique keys, and the frontmatter is
 * capped at 16 KB. Errors are a typed `FrontmatterError` the caller maps (`invalid_input`,
 * `invalid_archive`).
 */
import { parse, stringify } from 'yaml'
import { ITEM_LIMITS, utf8Length } from './frontmatter.js'

export interface FrontmatterIssue {
  path: string
  message: string
}

export class FrontmatterError extends Error {
  constructor(readonly issues: FrontmatterIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '))
    this.name = 'FrontmatterError'
  }
}

export interface SplitMarkdown {
  /** The YAML mapping (empty when the file has no frontmatter). */
  data: Record<string, unknown>
  /** Everything after the closing `---` line, byte for byte. */
  body: string
  hasFrontmatter: boolean
}

const FM_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

const firstLine = (s: string) => s.split('\n')[0]?.slice(0, 200) ?? 'invalid YAML'

/** Split `---\n<yaml>\n---\n<body>` (a leading BOM is dropped). */
export function splitFrontmatter(content: string): SplitMarkdown {
  const src = content.replace(/^﻿/, '')
  const m = FM_RE.exec(src)
  if (!m) return { data: {}, body: src, hasFrontmatter: false }
  const yamlText = m[1] ?? ''
  if (utf8Length(yamlText) > ITEM_LIMITS.frontmatterBytes) {
    throw new FrontmatterError([{ path: 'frontmatter', message: 'frontmatter is larger than 16 KB' }])
  }
  let data: unknown
  try {
    data =
      yamlText.trim() === '' ? null : parse(yamlText, { schema: 'core', maxAliasCount: 20, uniqueKeys: true })
  } catch (e) {
    throw new FrontmatterError([{ path: 'frontmatter', message: firstLine((e as Error).message) }])
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new FrontmatterError([{ path: 'frontmatter', message: 'frontmatter must be a YAML mapping' }])
  }
  return { data: data as Record<string, unknown>, body: src.slice(m[0].length), hasFrontmatter: true }
}

/** `---\n<yaml>---\n<body>`; key order is the insertion order of `frontmatter`; `{}` gives `---\n---\n`. */
export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const yaml =
    Object.keys(frontmatter).length === 0
      ? ''
      : stringify(frontmatter, { schema: 'core', lineWidth: 0, minContentWidth: 0 })
  return `---\n${yaml}---\n${body}`
}
