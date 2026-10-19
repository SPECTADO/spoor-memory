/**
 * Frontmatter edits on repo files (cli-and-hooks.md section 4.2 step 3). Only two edits exist: insert `spoor_id` as the
 * first key, and set the value of an existing `adr:` key after a renumber. The edit is a line insertion /
 * replacement in the YAML text, so comments, quoting, key order and the body stay byte-identical; the result is
 * re-parsed and checked, and only a block the line edit cannot handle (flow mapping, odd layout) goes through the
 * `yaml` Document API instead.
 */
import { isMap, parseDocument } from 'yaml'
import { isSpoorId } from './safety.js'

const FM_RE = /^(﻿?)---[ \t]*(\r?\n)(?:([\s\S]*?)\r?\n)?(---[ \t]*(?:\r?\n|$))/

interface Fm {
  bom: string
  nl: string
  yaml: string
  /** text before the YAML (BOM + opening fence) */
  head: string
  /** closing fence line and everything after it */
  tail: string
}

function splitRaw(content: string): Fm | undefined {
  const m = FM_RE.exec(content)
  if (!m) return undefined
  const bom = m[1] ?? ''
  const nl = m[2] ?? '\n'
  const head = content.slice(0, content.indexOf('\n') + 1)
  const tailStart = m[0].length - (m[4] ?? '').length
  return { bom, nl, yaml: m[3] ?? '', head, tail: content.slice(tailStart) }
}

function parseMap(yaml: string): Record<string, unknown> | undefined {
  try {
    const doc = parseDocument(yaml, { schema: 'core' })
    if (doc.errors.length > 0) return undefined
    if (doc.contents === null) return {}
    if (!isMap(doc.contents)) return undefined
    return doc.toJS() as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** The `spoor_id` in a file's frontmatter, if any (never throws). */
export function readSpoorId(content: string): string | undefined {
  const fm = splitRaw(content)
  if (!fm) return undefined
  const v = parseMap(fm.yaml)?.spoor_id
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

export function readFrontmatter(content: string): Record<string, unknown> | undefined {
  const fm = splitRaw(content)
  return fm ? parseMap(fm.yaml) : undefined
}

const sameExcept = (a: Record<string, unknown>, b: Record<string, unknown>, key: string) => {
  const strip = (o: Record<string, unknown>) => {
    const { [key]: _drop, ...rest } = o
    return JSON.stringify(rest)
  }
  return strip(a) === strip(b)
}

/**
 * Insert `spoor_id` as the first frontmatter key; a file without frontmatter gets a block with only `spoor_id`.
 * A file that already has a `spoor_id` is returned unchanged. Throws on an id that is not a uuid: the id comes from
 * the server and is written as raw text, so anything else could inject frontmatter keys or body lines.
 */
export function insertSpoorId(content: string, id: string): string {
  if (!isSpoorId(id)) throw new Error('refusing to write a spoor_id that is not a uuid')
  const fm = splitRaw(content)
  if (!fm) {
    const nl = content.includes('\r\n') ? '\r\n' : '\n'
    const bom = content.startsWith('﻿') ? '﻿' : ''
    return `${bom}---${nl}spoor_id: ${id}${nl}---${nl}${content.slice(bom.length)}`
  }
  const before = parseMap(fm.yaml)
  if (before && typeof before.spoor_id === 'string' && before.spoor_id.trim() !== '') return content
  if (before) {
    const yaml = fm.yaml.trim() === '' ? `spoor_id: ${id}` : `spoor_id: ${id}${fm.nl}${fm.yaml}`
    const after = parseMap(yaml)
    if (
      after &&
      after.spoor_id === id &&
      sameExcept(before, after, 'spoor_id') &&
      Object.keys(after)[0] === 'spoor_id'
    )
      return fm.head + yaml + fm.nl + fm.tail
  }
  // Fallback: Document API (keeps comments; may normalise layout of this block only).
  const doc = parseDocument(fm.yaml, { schema: 'core' })
  if (!isMap(doc.contents)) {
    if (doc.contents !== null) throw new Error('frontmatter is not a YAML mapping')
    return `${fm.head}spoor_id: ${id}${fm.nl}${fm.tail}`
  }
  doc.contents.items.unshift(doc.createPair('spoor_id', id))
  const text = doc.toString({ lineWidth: 0 }).replace(/\n$/, '').replace(/\n/g, fm.nl)
  return fm.head + text + fm.nl + fm.tail
}

/** Replace the value of an existing top-level `adr:` key; files without one are returned unchanged. */
export function setAdrNumber(content: string, n: number): string {
  const fm = splitRaw(content)
  if (!fm) return content
  const before = parseMap(fm.yaml)
  if (!before || !('adr' in before)) return content
  const re = /^adr:([ \t]*)[^#\r\n]*?([ \t]*(?:#.*)?)$/m
  if (re.test(fm.yaml)) {
    const yaml = fm.yaml.replace(re, (_m, sp: string, rest: string) => `adr:${sp || ' '}${n}${rest}`)
    const after = parseMap(yaml)
    if (after && after.adr === n && sameExcept(before, after, 'adr')) return fm.head + yaml + fm.nl + fm.tail
  }
  const doc = parseDocument(fm.yaml, { schema: 'core' })
  doc.set('adr', n)
  const text = doc.toString({ lineWidth: 0 }).replace(/\n$/, '').replace(/\n/g, fm.nl)
  return fm.head + text + fm.nl + fm.tail
}

/** Index where the Markdown body starts (after the frontmatter block, if any). */
export function bodyStart(content: string): number {
  const fm = splitRaw(content)
  return fm ? content.length - fm.tail.length + (/^---[ \t]*(?:\r?\n|$)/.exec(fm.tail)?.[0].length ?? 0) : 0
}

/**
 * After a renumber `from` → `to`: rewrite a body H1 that names the old number (`# 2. Title`, `# ADR-0002: Title`).
 * Returns the content unchanged when the H1 does not name it.
 */
export function rewriteAdrH1(content: string, from: number, to: number): string {
  const start = bodyStart(content)
  const body = content.slice(start)
  const m = /^#[ \t]+(.*)$/m.exec(body)
  if (!m) return content
  const line = m[0]
  const next = line
    .replace(new RegExp(`^(#[ \\t]+)0*${from}\\.`), `$1${to}.`)
    .replace(new RegExp(`\\bADR-0*${from}\\b`, 'i'), `ADR-${padAdr(to)}`)
  if (next === line) return content
  return content.slice(0, start) + body.slice(0, m.index) + next + body.slice(m.index + line.length)
}

/** ADR number of a file: frontmatter `adr`, then the file-name prefix, then the H1 (data-model.md section 7). */
export function adrNumberOf(fileName: string, content: string): number | undefined {
  const fmNum = readFrontmatter(content)?.adr
  if (typeof fmNum === 'number' && Number.isInteger(fmNum) && fmNum > 0) return fmNum
  if (typeof fmNum === 'string' && /^\d{1,5}$/.test(fmNum)) return Number(fmNum)
  const m = /^(\d{1,5})-/.exec(fileName)
  if (m) return Number(m[1])
  const h1 = /^#[ \t]+(.*)$/m.exec(content)
  if (h1) {
    const t = h1[1] ?? ''
    const a = /ADR-(\d{1,5})/i.exec(t) ?? /^(\d{1,5})\./.exec(t)
    if (a) return Number(a[1])
  }
  return undefined
}

export const padAdr = (n: number) => String(n).padStart(n >= 10000 ? 5 : 4, '0')
