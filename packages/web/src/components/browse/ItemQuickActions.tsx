import { Archive, Pin, PinOff, ShieldCheck } from 'lucide-react'
import { useItemAction } from '../../api/hooks'
import type { ItemAction, ItemSummary } from '../../api/types'
import { IconButton, useToast } from '../../ui'

/**
 * Pin/unpin, verify and archive for one list row (web-ui.md §4.2 `ItemActions`, the quick subset). The caller
 * renders it only for users who may write; the server enforces the role anyway. Archived items cannot be
 * verified or archived (restore is on the item page, where an expired observation needs a choice).
 */
export function ItemQuickActions({
  slug,
  item,
}: {
  slug: string
  item: Pick<ItemSummary, 'handle' | 'pinned' | 'lifecycle'>
}) {
  const action = useItemAction(slug)
  const toast = useToast()
  const archived = item.lifecycle === 'archived'

  const run = (a: ItemAction, done: string) =>
    action.mutate(
      { ref: item.handle, action: a },
      { onSuccess: () => toast.success(`${done} ${item.handle}`), onError: (e) => toast.error(e) },
    )

  return (
    <span className="inline-flex gap-0.5">
      {item.pinned ? (
        <IconButton
          label={`Unpin ${item.handle}`}
          icon={<PinOff className="size-4" />}
          disabled={action.isPending}
          onClick={() => run('unpin', 'Unpinned')}
        />
      ) : (
        <IconButton
          label={`Pin ${item.handle}`}
          icon={<Pin className="size-4" />}
          disabled={action.isPending}
          onClick={() => run('pin', 'Pinned')}
        />
      )}
      {!archived && (
        <IconButton
          label={`Verify ${item.handle}`}
          icon={<ShieldCheck className="size-4" />}
          disabled={action.isPending}
          onClick={() => run('verify', 'Verified')}
        />
      )}
      {!archived && (
        <IconButton
          label={`Archive ${item.handle}`}
          icon={<Archive className="size-4" />}
          disabled={action.isPending}
          onClick={() => run('archive', 'Archived')}
        />
      )}
    </span>
  )
}
