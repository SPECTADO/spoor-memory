/**
 * `LinksPanel` (web-ui.md §4.2): outgoing and incoming edges grouped by kind (typed relations, supersedes,
 * drafted_from, wikilinks and backlinks). Dangling wikilinks are muted, with "create" for writers; typed edges
 * have a remove button; "Add relation" opens the picker dialog.
 */
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useEdges, useRemoveEdge } from '../../api/hooks'
import type { EdgeJson, EdgeKind, ItemJson } from '../../api/types'
import { projectPath } from '../../lib/paths'
import { Button, ErrorState, IconButton, SkeletonRows, useToast } from '../../ui'
import { ItemLink } from './common'
import { RelationDialog } from './ItemDialogs'

const OUT_LABEL: Record<EdgeKind, string> = {
  refines: 'Refines',
  supports: 'Supports',
  depends_on: 'Depends on',
  conflicts_with: 'Conflicts with',
  supersedes: 'Supersedes',
  drafted_from: 'Drafted from',
  wikilink: 'Links to',
}
const IN_LABEL: Record<EdgeKind, string> = {
  refines: 'Refined by',
  supports: 'Supported by',
  depends_on: 'Needed by',
  conflicts_with: 'Conflicts with',
  supersedes: 'Superseded by',
  drafted_from: 'Drafted into',
  wikilink: 'Linked from',
}
const ORDER: EdgeKind[] = [
  'supersedes',
  'conflicts_with',
  'refines',
  'supports',
  'depends_on',
  'drafted_from',
  'wikilink',
]

function group(edges: EdgeJson[]): [EdgeKind, EdgeJson[]][] {
  return ORDER.map((k) => [k, edges.filter((e) => e.kind === k)] as [EdgeKind, EdgeJson[]]).filter(
    ([, es]) => es.length > 0,
  )
}

export function LinksPanel({ slug, item, canWrite }: { slug: string; item: ItemJson; canWrite: boolean }) {
  const edges = useEdges(slug, item.handle)
  const remove = useRemoveEdge(slug)
  const toast = useToast()
  const [adding, setAdding] = useState(false)

  const row = (e: EdgeJson, dir: 'out' | 'in') => (
    <li key={`${dir}-${e.id}`} className="flex items-start justify-between gap-2 py-1 text-sm">
      {e.other ? (
        <ItemLink
          item={e.other}
          className="min-w-0 break-words text-accent underline-offset-2 hover:underline"
        />
      ) : (
        <span className="min-w-0 break-words text-muted">
          <span className="font-mono text-xs">[[{e.dst_ref}]]</span> (no such item)
          {canWrite && e.dst_ref && (
            <>
              {' '}
              <Link
                to={projectPath(
                  slug,
                  // only a library page resolves a library page's dangling link (ADR-0014)
                  `${item.space === 'library' ? 'library' : 'docs'}/new?title=${encodeURIComponent(e.dst_ref)}`,
                )}
                className="text-accent underline"
              >
                create
              </Link>
            </>
          )}
        </span>
      )}
      {canWrite && e.editable && (
        <IconButton
          label={`Remove relation ${e.kind.replace('_', ' ')} ${e.other?.handle ?? e.dst_ref ?? ''}`.trim()}
          icon={<X className="size-4" aria-hidden="true" />}
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(e.id, {
              onSuccess: () => toast.success('Relation removed'),
              onError: (err) => toast.error(err),
            })
          }
        />
      )}
    </li>
  )

  const section = (title: string, list: EdgeJson[], dir: 'out' | 'in', labels: Record<EdgeKind, string>) => {
    const groups = group(list)
    return (
      <div>
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
        {groups.length === 0 ? (
          <p className="mt-1 text-sm text-muted">None.</p>
        ) : (
          <dl className="mt-1 space-y-2">
            {groups.map(([kind, es]) => (
              <div key={kind}>
                <dt className="text-sm font-medium">{labels[kind]}</dt>
                <dd>
                  <ul className="divide-y divide-border">{es.map((e) => row(e, dir))}</ul>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    )
  }

  return (
    <section aria-labelledby="links-heading" className="rounded-md border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="links-heading" className="text-base font-semibold">
          Links
        </h2>
        {canWrite && (
          <Button
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => setAdding(true)}
          >
            {item.space === 'library' ? 'Add link' : 'Add relation'}
          </Button>
        )}
      </div>
      {edges.isPending ? (
        <SkeletonRows rows={2} label="Loading links" />
      ) : edges.isError ? (
        <ErrorState error={edges.error} onRetry={() => edges.refetch()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {section('Outgoing', edges.data.outgoing, 'out', OUT_LABEL)}
          {section('Incoming (backlinks)', edges.data.incoming, 'in', IN_LABEL)}
        </div>
      )}
      <RelationDialog open={adding} onClose={() => setAdding(false)} slug={slug} item={item} />
    </section>
  )
}
