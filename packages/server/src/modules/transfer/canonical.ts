/**
 * Canonical Markdown files of an export (data-model.md sections 5 and 8): the file is the shared
 * `serializeMarkdown` of `@spoor/shared` (the one serializer: core schema, fixed key order, 16 KB
 * frontmatter cap on the way back in) plus the sha256 over the exact bytes; `readMarkdown` is the shared
 * splitter with its typed error mapped to `invalid_archive`.
 */
import { createHash } from 'node:crypto'
import { FrontmatterError, splitFrontmatter } from '@spoor/shared'
import { invalidArchive } from './errors.js'

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The shared splitter for an archive entry: `{fm, body}`, or 422 `invalid_archive` naming the entry. */
export function readMarkdown(text: string, path: string): { fm: Record<string, unknown>; body: string } {
  try {
    const { data, body } = splitFrontmatter(text)
    return { fm: data, body }
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw invalidArchive(`Frontmatter of ${path} is invalid.`, [
        { path, message: err.issues[0]?.message ?? 'invalid frontmatter' },
      ])
    }
    throw err
  }
}
