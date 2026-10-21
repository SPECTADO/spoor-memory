/**
 * `LinksPanel` (web-ui.md §4.2): outgoing and incoming edges grouped by kind (typed relations, supersedes,
 * drafted_from, wikilinks and backlinks). Dangling wikilinks are muted, with "create" for writers; typed edges
 * have a remove button; "Add relation" opens the picker dialog.
 */
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAddEdge, useEdges, useRelated, useRemoveEdge } from '../../api/hooks'
import type { EdgeJson, EdgeKind, ItemJson, RelatedItem, RelationKind } from '../../api/types'
import { ItemBadges } from '../../components/browse/ItemBadges'
import { projectPath } from '../../lib/paths'
import { Button, ErrorState, IconButton, Select, SkeletonRows, useToast } from '../../ui'
import { ItemLink } from './common'
import { RELATION_KINDS, RELATION_LABEL, RelationDialog } from './ItemDialogs'

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

function SuggestionRow({ slug, item, s }: { slug: string; item: ItemJson; s: RelatedItem }) {
  const add = useAddEdge(slug)
  const toast = useToast()
  const [kind, setKind] = useState<RelationKind>('refines')
  // stays set after this row's own successful link, until the refetch drops the row (no duplicate edge)
  const [linked, setLinked] = useState(false)
  // conflicts_with is refused between a library page and anything else (as in the relation dialog)
  const involvesLibrary = item.space === 'library' || s.item.space === 'library'
  const kinds = involvesLibrary ? RELATION_KINDS.filter((k) => k !== 'conflicts_with') : RELATION_KINDS
  const effective: RelationKind = kinds.includes(kind) ? kind : 'refines'
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <ItemLink
          item={s.item}
          className="min-w-0 break-words text-accent underline-offset-2 hover:underline"
        />
        <ItemBadges item={s.item} />
        <span className="text-xs text-muted">similar {s.cos.toFixed(2)}</span>
      </span>
      <span className="flex items-center gap-2">
        <Select
          label={`Relation kind for ${s.item.handle}`}
          hideLabel
          value={effective}
          onChange={(e) => setKind(e.target.value as RelationKind)}
          options={kinds.map((k) => ({ value: k, label: RELATION_LABEL[k] }))}
        />
        <Button
          size="sm"
          disabled={add.isPending || linked}
          aria-label={`Link ${s.item.handle}`}
          onClick={() =>
            add.mutate(
              { ref: item.handle, kind: effective, to: s.item.handle },
              {
                onSuccess: () => {
                  setLinked(true)
                  toast.success(`${item.handle} ${RELATION_LABEL[effective]} ${s.item.handle}`)
                },
                onError: (err) => toast.error(err),
              },
            )
          }
        >
          Link
        </Button>
      </span>
    </li>
  )
}

function Suggestions({ slug, item, canWrite }: { slug: string; item: ItemJson; canWrite: boolean }) {
  const related = useRelated(slug, item.handle)
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Suggested links</h3>
      {related.isPending ? (
        <SkeletonRows rows={2} label="Loading suggestions" />
      ) : related.isError ? (
        <p className="mt-1 text-sm text-muted">
          Suggestions unavailable{' '}
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            onClick={() => related.refetch()}
          >
            Retry
          </button>
        </p>
      ) : related.data.items.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{related.data.note ?? 'No suggestions yet'}</p>
      ) : (
        <>
          {related.data.note && <p className="mt-1 text-sm text-muted">{related.data.note}</p>}
          <ul className="mt-1 divide-y divide-border">
            {related.data.items.map((s) =>
              canWrite ? (
                <SuggestionRow key={s.item.id} slug={slug} item={item} s={s} />
              ) : (
                <li key={s.item.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                  <ItemLink item={s.item} className="text-accent underline-offset-2 hover:underline" />
                  <ItemBadges item={s.item} />
                  <span className="text-xs text-muted">similar {s.cos.toFixed(2)}</span>
                </li>
              ),
            )}
          </ul>
        </>
      )}
    </div>
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
      <Suggestions slug={slug} item={item} canWrite={canWrite} />
      <RelationDialog open={adding} onClose={() => setAdding(false)} slug={slug} item={item} />
    </section>
  )
}
