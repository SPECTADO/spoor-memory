/**
 * Unsent editor drafts in localStorage (web-ui.md §5.2): a per-viewer convenience under
 * `spoor:draft:<slug>:<id|new:space>`. Every access is wrapped: in a private window or with blocked storage
 * the editor simply works without drafts.
 */
import type { EditorValues } from './editorModel'

export interface Draft {
  values: EditorValues
  /** The revision the draft was based on (edit mode). */
  revision: number | null
  saved_at: string
}

export const draftKey = (slug: string, target: { id: string } | { space: string }) =>
  `spoor:draft:${slug}:${'id' in target ? target.id : `new:${target.space}`}`

export function readDraft(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Draft>
    const v = d?.values as Partial<EditorValues> | undefined
    if (!v || typeof v.title !== 'string' || typeof v.body !== 'string' || !Array.isArray(v.tags)) return null
    if (typeof d.saved_at !== 'string') return null
    return { values: d.values as EditorValues, revision: d.revision ?? null, saved_at: d.saved_at }
  } catch {
    return null
  }
}

export function writeDraft(key: string, values: EditorValues, revision: number | null) {
  try {
    const d: Draft = { values, revision, saved_at: new Date().toISOString() }
    window.localStorage.setItem(key, JSON.stringify(d))
  } catch {
    // storage full or blocked: drafts are a convenience only
  }
}

export function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
