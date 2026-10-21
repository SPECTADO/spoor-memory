/**
 * Side card of the selected map node: title, badges, degree, its links grouped by kind (from the loaded graph),
 * suggested links (`GET …/related`, one-click "Link" for writers), "Add relation", "Open item" and
 * "Focus here". A node of another space (a shared ghost) opens there. Escape or the close button closes it.
 */
import { Link2, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAddEdge, useItem, useRelated } from '../../api/hooks'
import type { RelatedItem, RelationKind } from '../../api/types'
import { useCan } from '../../components/RequireRole'
import type { GraphView, ViewEdge, ViewNode } from '../../lib/graphLayout'
import { graphPath, projectPath } from '../../lib/paths'
import { Button, ButtonLink, IconButton, Select, SkeletonRows, useToast } from '../../ui'
import { handleText, ItemBadges, ItemLink, SPACE_LABEL, summaryPath } from '../item/common'
import { RELATION_KINDS, RELATION_LABEL, RelationDialog } from '../item/ItemDialogs'
import { IN_LABEL, KIND_ORDER, nodePlace, nodeState, OUT_LABEL } from './graphStyle'

export function NodeCard({
  slug,
  v,
  view,
  onClose,
  onSelect,
  onFocus,
}: {
  slug: string
  v: ViewNode
  view: GraphView
  onClose: () => void
  onSelect: (id: string) => void
  /** Focus the map on a handle of this project (`focus=<handle>&depth=2`). */
  onFocus: (handle: string) => void
}) {
  const n = v.node
  const local = !!n && n.project === slug
  const plain = n ? n.handle.replace(/^S:/, '') : undefined
  const full = useItem(n ? n.project : slug, plain)
  const canEdit = useCan('editor').allowed
  const canLibrary = useCan('library').allowed
  const canWrite = local && (n?.space === 'library' ? canLibrary : canEdit)
  const [adding, setAdding] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus when another node is opened
  useEffect(() => heading.current?.focus(), [v.id])

  const byId = new Map(view.nodes.map((x) => [x.id, x]))
  const out = view.edges.filter((e) => e.src === v.id)
  const inc = view.edges.filter((e) => e.dst === v.id)

  return (
    <aside
      aria-labelledby="node-card-heading"
      className="min-w-0 self-start rounded-md border border-border bg-bg p-4 text-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id="node-card-heading"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 text-base font-semibold break-words"
        >
          {!n ? (
            <span className="font-mono">[[{v.ref}]]</span>
          ) : full.data ? (
            <ItemLink item={full.data} />
          ) : (
            <Link to={summaryPath(n)} className="text-accent underline-offset-2 hover:underline">
              <span className="font-mono text-xs">{handleText(n)}</span> {n.title}
            </Link>
          )}
        </h2>
        <IconButton
          label="Close details"
          icon={<X className="size-4" aria-hidden="true" />}
          onClick={onClose}
        />
      </div>

      <div className="mt-2 space-y-2">
        {n && full.data && <ItemBadges item={full.data} />}
        {n && !full.data && <p className="text-muted">{SPACE_LABEL[n.space]}</p>}
        {full.data
          ? nodePlace(v, slug) && <p className="text-muted">{nodePlace(v, slug)}</p>
          : nodeState(v, slug).length > 0 && <p className="text-muted">{nodeState(v, slug).join(', ')}</p>}
        <p>
          {v.degree} {v.degree === 1 ? 'link' : 'links'}
          {n && (
            <span className="text-muted">
              {' '}
              ({n.degree_out} outgoing, {n.degree_in} incoming)
            </span>
          )}
        </p>
        {!n && <DanglingNote slug={slug} refText={v.ref ?? ''} />}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {n && (
          <ButtonLink to={summaryPath(n)} size="sm" variant="primary">
            Open item
          </ButtonLink>
        )}
        {n && local && (
          <Button size="sm" onClick={() => onFocus(n.handle)}>
            Focus here
          </Button>
        )}
        {n && !local && plain && (
          <ButtonLink to={graphPath(n.project, { focus: plain, depth: 2 })} size="sm">
            Focus here
          </ButtonLink>
        )}
        {canWrite && full.data && (
          <Button
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => setAdding(true)}
          >
            {n?.space === 'library' ? 'Add link' : 'Add relation'}
          </Button>
        )}
      </div>

      <section aria-label="Links on the map" className="mt-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Links</h3>
        {out.length + inc.length === 0 ? (
          <p className="mt-1 text-muted">No links in this view.</p>
        ) : (
          <dl className="mt-1 space-y-2">
            {groups(out, OUT_LABEL).map(([title, es]) => (
              <LinkGroup
                key={`out-${title}`}
                title={title}
                ids={es.map((e) => e.dst)}
                byId={byId}
                onSelect={onSelect}
              />
            ))}
            {groups(inc, IN_LABEL).map(([title, es]) => (
              <LinkGroup
                key={`in-${title}`}
                title={title}
                ids={es.map((e) => e.src)}
                byId={byId}
                onSelect={onSelect}
              />
            ))}
          </dl>
        )}
      </section>

      {local && n && <Suggestions slug={slug} handle={n.handle} space={n.space} canWrite={canWrite} />}

      {full.data && canWrite && (
        <RelationDialog open={adding} onClose={() => setAdding(false)} slug={slug} item={full.data} />
      )}
    </aside>
  )
}

function groups(es: ViewEdge[], labels: typeof OUT_LABEL): [string, ViewEdge[]][] {
  return KIND_ORDER.map((k) => [labels[k], es.filter((e) => e.kind === k)] as [string, ViewEdge[]]).filter(
    ([, list]) => list.length > 0,
  )
}

function LinkGroup({
  title,
  ids,
  byId,
  onSelect,
}: {
  title: string
  ids: string[]
  byId: Map<string, ViewNode>
  onSelect: (id: string) => void
}) {
  return (
    <div>
      <dt className="font-medium">{title}</dt>
      <dd>
        <ul>
          {ids.map((id) => {
            const other = byId.get(id)
            if (!other) return null
            const name = other.node ? `${handleText(other.node)} ${other.node.title}` : `[[${other.ref}]]`
            return (
              <li key={id}>
                <button
                  type="button"
                  className="text-left text-accent underline-offset-2 hover:underline"
                  aria-label={`Show ${name} on the map`}
                  onClick={() => onSelect(id)}
                >
                  {other.node ? (
                    <>
                      <span className="font-mono text-xs">{handleText(other.node)}</span> {other.node.title}
                    </>
                  ) : (
                    <span className="font-mono text-xs text-muted">[[{other.ref}]]</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </dd>
    </div>
  )
}

function DanglingNote({ slug, refText }: { slug: string; refText: string }) {
  const canEdit = useCan('editor').allowed
  return (
    <p className="text-muted">
      No item has this reference yet.
      {canEdit && (
        <>
          {' '}
          <Link
            to={projectPath(slug, `docs/new?title=${encodeURIComponent(refText)}`)}
            className="text-accent underline"
          >
            Create it as a doc
          </Link>
        </>
      )}
    </p>
  )
}

function Suggestions({
  slug,
  handle,
  space,
  canWrite,
}: {
  slug: string
  handle: string
  space: string
  canWrite: boolean
}) {
  const related = useRelated(slug, handle)
  return (
    <section aria-labelledby="suggested-heading" className="mt-4">
      <h3 id="suggested-heading" className="text-xs font-semibold tracking-wide text-muted uppercase">
        Suggested links
      </h3>
      {related.isPending ? (
        <SkeletonRows rows={2} label="Loading suggestions" />
      ) : related.isError ? (
        <p className="mt-1 text-muted">
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
        <p className="mt-1 text-muted">{related.data.note ?? 'No similar unlinked items.'}</p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {related.data.items.map((r) => (
            <Suggestion key={r.item.id} slug={slug} handle={handle} space={space} r={r} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Suggestion({
  slug,
  handle,
  space,
  r,
  canWrite,
}: {
  slug: string
  handle: string
  space: string
  r: RelatedItem
  canWrite: boolean
}) {
  const add = useAddEdge(slug)
  const toast = useToast()
  // conflicts_with is refused between a library page and anything else
  const kinds =
    space === 'library' || r.item.space === 'library'
      ? RELATION_KINDS.filter((k) => k !== 'conflicts_with')
      : RELATION_KINDS
  const [kind, setKind] = useState<RelationKind>('refines')
  // stays set after this row's own successful link, until the refetch drops the row (no duplicate edge)
  const [linked, setLinked] = useState(false)
  const link = () =>
    add.mutate(
      { ref: handle, kind, to: r.item.handle },
      {
        onSuccess: () => {
          setLinked(true)
          toast.success(`${handle} ${RELATION_LABEL[kind]} ${r.item.handle}`)
        },
        onError: (e) => toast.error(e),
      },
    )
  return (
    <li className="space-y-1 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <ItemLink
          item={r.item}
          className="min-w-0 break-words text-accent underline-offset-2 hover:underline"
        />
        <span className="shrink-0 text-xs text-muted">similarity {r.cos.toFixed(2)}</span>
      </div>
      {canWrite && (
        <div className="flex items-end gap-2">
          <Select
            label={`Link kind for ${r.item.handle}`}
            hideLabel
            className="flex-1"
            value={kind}
            options={kinds.map((k) => ({ value: k, label: RELATION_LABEL[k] }))}
            onChange={(e) => setKind(e.target.value as RelationKind)}
          />
          <Button
            size="sm"
            icon={<Link2 className="size-4" aria-hidden="true" />}
            loading={add.isPending}
            disabled={linked}
            aria-label={`Link ${handle} ${RELATION_LABEL[kind]} ${r.item.handle}`}
            onClick={link}
          >
            Link
          </Button>
        </div>
      )}
    </li>
  )
}
