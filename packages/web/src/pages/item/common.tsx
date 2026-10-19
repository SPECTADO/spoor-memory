/** Small pieces shared by the item view, the editor and the history page. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ItemSummary, Space } from '../../api/types'
import { fromNow } from '../../lib/format'
import { itemPath } from '../../lib/paths'
import { Badge, type BadgeTone } from '../../ui'

export const SPACE_LABEL: Record<Space, string> = { memories: 'memory', decisions: 'decision', docs: 'doc' }
export const SPACE_TITLE: Record<Space, string> = {
  memories: 'Memories',
  decisions: 'Decisions',
  docs: 'Docs',
}
export const SPACES: readonly Space[] = ['memories', 'decisions', 'docs']
export const isSpace = (s: string | undefined): s is Space => !!s && (SPACES as readonly string[]).includes(s)

/** Path of an item seen in a list or an edge: its own project (an `S:` handle lives under /shared). */
export const summaryPath = (s: Pick<ItemSummary, 'project' | 'handle'>) =>
  itemPath(s.project, s.handle.replace(/^S:/, ''))

/** `m42` plus `~` when an agent wrote it and no human has edited, verified or pinned it since. */
export function handleText(s: Pick<ItemSummary, 'handle' | 'provenance'>): string {
  return s.provenance === 'agent' ? `${s.handle}~` : s.handle
}

/** Handle and title as one link. */
export function ItemLink({ item, className }: { item: ItemSummary; className?: string }) {
  return (
    <Link to={summaryPath(item)} className={className ?? 'text-accent underline-offset-2 hover:underline'}>
      <span className="font-mono text-xs">{handleText(item)}</span> {item.title}
    </Link>
  )
}

const statusTone = (status: string): BadgeTone =>
  status === 'accepted' || status === 'active'
    ? 'success'
    : status === 'proposed'
      ? 'accent'
      : status === 'superseded' || status === 'deprecated'
        ? 'warning'
        : 'neutral'

/** Lifecycle as text: nothing for active, `stale`, `archived (expired)`. */
export function lifecycleText(s: Pick<ItemSummary, 'lifecycle' | 'archive_reason'>): string | null {
  if (s.lifecycle === 'active') return null
  if (s.lifecycle === 'archived' && s.archive_reason) return `archived (${s.archive_reason})`
  return s.lifecycle
}

/** The header badges of web-ui.md §4.2 (always text, never colour alone). */
export function ItemBadges({ item, showSpace = true }: { item: ItemSummary; showSpace?: boolean }) {
  const life = lifecycleText(item)
  return (
    <div className="flex flex-wrap gap-1.5">
      {showSpace && <Badge>{SPACE_LABEL[item.space]}</Badge>}
      {item.type && <Badge>{item.type}</Badge>}
      {item.confidence && <Badge>confidence: {item.confidence}</Badge>}
      {item.space !== 'docs' || item.status !== 'active' ? (
        <Badge tone={statusTone(item.status)}>{item.status}</Badge>
      ) : null}
      {life && <Badge tone={item.lifecycle === 'stale' ? 'warning' : 'danger'}>{life}</Badge>}
      {item.pinned && <Badge tone="accent">pinned</Badge>}
      {item.source_path && (
        <Badge className="max-w-full truncate" tone="neutral">
          mirrors <span className="font-mono">{item.source_path}</span>
        </Badge>
      )}
      {item.provenance === 'agent' && <Badge tone="warning">agent-written</Badge>}
      {item.push_conflict_at && <Badge tone="danger">push refused</Badge>}
    </div>
  )
}

/** "3 hours ago" with the exact time as a tooltip and a machine-readable `<time>`. */
export function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted">never</span>
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString('en-GB')}>
      {fromNow(iso)}
    </time>
  )
}

/** `value`, updated only after it stopped changing for `ms` (the editor's live preview). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
