import { Pin } from 'lucide-react'
import type { ItemSummary } from '../../api/types'
import { Badge } from '../../ui'

/** Type, status and lifecycle of an item as text badges (colour is never the only signal). */
export function ItemBadges({
  item,
  showType = true,
}: {
  item: Pick<ItemSummary, 'type' | 'status' | 'lifecycle' | 'pinned' | 'archive_reason' | 'push_conflict_at'>
  showType?: boolean
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {showType && item.type && <Badge>{item.type}</Badge>}
      {item.status !== 'active' && (
        <Badge tone={item.status === 'accepted' ? 'success' : 'neutral'}>{item.status}</Badge>
      )}
      {item.lifecycle === 'stale' && <Badge tone="warning">stale</Badge>}
      {item.lifecycle === 'archived' && (
        <Badge>archived{item.archive_reason ? ` (${item.archive_reason})` : ''}</Badge>
      )}
      {item.pinned && (
        <Badge tone="accent">
          <Pin className="size-3" aria-hidden="true" />
          pinned
        </Badge>
      )}
      {item.push_conflict_at && <Badge tone="danger">push refused</Badge>}
    </span>
  )
}
