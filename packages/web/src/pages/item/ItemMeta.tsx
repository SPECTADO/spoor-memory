/**
 * The frontmatter side panel of the item view (web-ui.md §4.2): type, status, confidence, tags (link to the
 * list filtered by tag), anchors, provenance (`~`), dates, who and via what, revision with a history link,
 * the mirrored source path, the superseded-by chain and the extra frontmatter keys.
 */
import { Network } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useItem } from '../../api/hooks'
import type { ItemJson } from '../../api/types'
import { dateTime } from '../../lib/format'
import { graphPath, itemPath, projectPath } from '../../lib/paths'
import { ButtonLink } from '../../ui'
import { lifecycleText, When } from './common'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** "Superseded by m60 → m72": follows `superseded_by` up to five hops (guards against cycles). */
export function SupersededChain({
  slug,
  handle,
  seen = [],
}: {
  slug: string
  handle: string
  seen?: string[]
}) {
  const next = useItem(slug, handle)
  const after = next.data?.superseded_by
  const more = after && seen.length < 4 && !seen.includes(after) && after !== handle
  return (
    <>
      <Link to={itemPath(slug, handle)} className="text-accent underline">
        <span className="font-mono">{handle}</span>
        {next.data && <> {next.data.title}</>}
      </Link>
      {more && (
        <>
          {' → '}
          <SupersededChain slug={slug} handle={after} seen={[...seen, handle]} />
        </>
      )}
    </>
  )
}

export function ItemMeta({ slug, item }: { slug: string; item: ItemJson }) {
  const life = lifecycleText(item)
  const extraKeys = Object.keys(item.extra ?? {})
  return (
    <section aria-labelledby="meta-heading" className="rounded-md border border-border p-4 text-sm">
      <h2 id="meta-heading" className="mb-2 text-base font-semibold">
        Details
      </h2>
      <ButtonLink to={graphPath(slug, { focus: item.handle, depth: 2 })} size="sm" className="mb-2">
        <Network className="size-4" aria-hidden="true" />
        Open in map
      </ButtonLink>
      <dl className="divide-y divide-border">
        {item.type && <Row label="Type">{item.type}</Row>}
        {((item.space !== 'docs' && item.space !== 'library') || item.status !== 'active') && (
          <Row label="Status">{item.status}</Row>
        )}
        {item.adr_number !== null && <Row label="ADR">{String(item.adr_number).padStart(4, '0')}</Row>}
        {item.decided_on && <Row label="Decided on">{item.decided_on}</Row>}
        {item.confidence && <Row label="Confidence">{item.confidence}</Row>}
        <Row label="Lifecycle">{life ?? 'active'}</Row>
        {item.superseded_by && (
          <Row label="Superseded by">
            <SupersededChain slug={slug} handle={item.superseded_by} seen={[item.handle]} />
          </Row>
        )}
        <Row label="Tags">
          {item.tags.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {item.tags.map((t) => (
                <li key={t}>
                  <Link
                    to={projectPath(slug, `${item.space}?tag=${encodeURIComponent(t)}`)}
                    className="rounded bg-surface-2 px-1.5 py-0.5 text-xs hover:underline"
                    aria-label={`Items tagged ${t}`}
                  >
                    {t}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Anchors">
          {item.anchors.length === 0 ? (
            <span className="text-muted">none</span>
          ) : (
            <ul className="space-y-0.5 font-mono text-xs">
              {item.anchors.map((a) => (
                <li key={a} className="break-all">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Written by">
          {item.provenance === 'agent' ? (
            <>
              an agent <span className="font-mono">~</span>
              <span className="block text-xs text-muted">
                No human has edited, verified or pinned it since.
              </span>
            </>
          ) : (
            'a human (or reviewed by one)'
          )}
        </Row>
        {item.space !== 'library' && (
          <Row label="Last verified">
            <When iso={item.last_verified_at} />
          </Row>
        )}
        <Row label="Last used">
          <When iso={item.last_used_at} />
        </Row>
        {item.expires_at && (
          <Row label="Expires">
            <When iso={item.expires_at} />
          </Row>
        )}
        {item.stale_since && (
          <Row label="Stale since">
            <When iso={item.stale_since} />
          </Row>
        )}
        {item.archived_at && (
          <Row label="Archived">
            <When iso={item.archived_at} />
            {item.archive_reason && <> ({item.archive_reason})</>}
          </Row>
        )}
        <Row label="Created">
          {dateTime(item.created_at)}
          <span className="block text-xs text-muted">by {item.created_by.label}</span>
        </Row>
        <Row label="Updated">
          {dateTime(item.updated_at)}
          <span className="block text-xs text-muted">
            by {item.updated_by}
            {item.client_name && <> via {item.client_name}</>}
          </span>
        </Row>
        <Row label="Revision">
          r{item.revision} ·{' '}
          <Link to={itemPath(slug, item.handle, 'history')} className="text-accent underline">
            History
          </Link>
        </Row>
        {item.source_path && (
          <Row label="Mirrors">
            <code className="font-mono text-xs break-all">{item.source_path}</code>
            {item.push_conflict_at && (
              <span className="block text-xs text-danger">
                Push refused {dateTime(item.push_conflict_at)}
              </span>
            )}
          </Row>
        )}
        <Row label="Slug">
          <code className="font-mono text-xs break-all">{item.slug}</code>
        </Row>
      </dl>
      {extraKeys.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer font-medium">Extra metadata ({extraKeys.length})</summary>
          <dl className="mt-2 space-y-1">
            {extraKeys.map((k) => (
              <div key={k}>
                <dt className="font-mono text-xs text-muted">{k}</dt>
                <dd className="font-mono text-xs break-all">{JSON.stringify(item.extra[k])}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  )
}
