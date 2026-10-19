import { Link } from 'react-router'
import type { ItemSummary, Space } from '../../api/types'
import { fromNow } from '../../lib/format'
import { itemPath } from '../../lib/paths'
import { cx, Table, TBody, Td, THead, Th, Tr } from '../../ui'
import { ItemBadges } from './ItemBadges'
import { ItemQuickActions } from './ItemQuickActions'

/**
 * Rows of a space list: handle, title, badges, tags, updated, last verified, and for memories the expiry of
 * observations. Stale rows are tinted. Tags are buttons that add a tag filter; quick actions only when
 * `canWrite`. Less important columns drop out on narrow screens.
 */
export function ItemTable({
  slug,
  space,
  items,
  canWrite,
  onTagClick,
}: {
  slug: string
  space: Space
  items: ItemSummary[]
  canWrite: boolean
  onTagClick?: (tag: string) => void
}) {
  const label = { memories: 'Memories', decisions: 'Decisions', docs: 'Docs' }[space]
  return (
    <Table caption={label}>
      <THead>
        <tr>
          <Th>Handle</Th>
          <Th>Title</Th>
          <Th className="hidden md:table-cell">Tags</Th>
          <Th>Updated</Th>
          <Th className="hidden lg:table-cell">Verified</Th>
          {space === 'memories' && <Th className="hidden lg:table-cell">Expires</Th>}
          {canWrite && <Th>Actions</Th>}
        </tr>
      </THead>
      <TBody>
        {items.map((item) => (
          <Tr key={item.id} className={cx(item.lifecycle === 'stale' && 'bg-warning-soft/40')}>
            <Td className="font-mono whitespace-nowrap">{item.handle}</Td>
            <Td className="min-w-48">
              <Link to={itemPath(slug, item.handle)} className="font-medium text-accent hover:underline">
                {item.title}
              </Link>
              <div className="mt-1">
                <ItemBadges item={item} />
              </div>
            </Td>
            <Td className="hidden md:table-cell">
              <span className="flex flex-wrap gap-1">
                {item.tags.map((t) =>
                  onTagClick ? (
                    <button
                      key={t}
                      type="button"
                      aria-label={`Filter by tag ${t}`}
                      onClick={() => onTagClick(t)}
                      className="rounded bg-surface-2 px-1.5 py-0.5 text-xs hover:bg-accent-soft"
                    >
                      {t}
                    </button>
                  ) : (
                    <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                      {t}
                    </span>
                  ),
                )}
              </span>
            </Td>
            <Td className="whitespace-nowrap">
              <time dateTime={item.updated_at} title={item.updated_at}>
                {fromNow(item.updated_at)}
              </time>
            </Td>
            <Td className="hidden whitespace-nowrap lg:table-cell">
              <time dateTime={item.last_verified_at} title={item.last_verified_at}>
                {fromNow(item.last_verified_at)}
              </time>
            </Td>
            {space === 'memories' && (
              <Td className="hidden whitespace-nowrap lg:table-cell">
                {item.expires_at ? fromNow(item.expires_at) : '—'}
              </Td>
            )}
            {canWrite && (
              <Td>
                <ItemQuickActions slug={slug} item={item} />
              </Td>
            )}
          </Tr>
        ))}
      </TBody>
    </Table>
  )
}
