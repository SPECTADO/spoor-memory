/**
 * The map as tables (`?view=list`, and the screen-reader route to the same data): every node with its handle,
 * title, space, state and link count, then every link as "from — kind — to". "Details" opens the side card.
 */
import { Link } from 'react-router'
import type { GraphView, ViewNode } from '../../lib/graphLayout'
import { Button, Table, TBody, Td, THead, Th, Tr } from '../../ui'
import { handleText, SPACE_LABEL, summaryPath } from '../item/common'
import { KIND_LABEL, nodeState } from './graphStyle'

function NodeName({ v }: { v: ViewNode }) {
  if (!v.node) return <span className="font-mono text-xs text-muted">[[{v.ref}]]</span>
  return (
    <Link to={summaryPath(v.node)} className="text-accent underline-offset-2 hover:underline">
      <span className="font-mono text-xs">{handleText(v.node)}</span> {v.node.title}
    </Link>
  )
}

export function GraphList({
  slug,
  view,
  matches,
  onSelect,
}: {
  slug: string
  view: GraphView
  matches: Set<string> | null
  onSelect: (id: string) => void
}) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  return (
    <div className="space-y-6">
      <Table caption={`Nodes on the map (${view.nodes.length})`} hideCaption={false}>
        <THead>
          <Tr>
            <Th>Item</Th>
            <Th>Space</Th>
            <Th>Links</Th>
            <Th>State</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {view.nodes.map((v) => (
            <Tr key={v.id} className={matches?.has(v.id) ? 'bg-accent-soft' : undefined}>
              <Td className="min-w-0 break-words">
                <NodeName v={v} />
                {matches?.has(v.id) && <span className="ml-1 text-xs text-muted">(matches)</span>}
              </Td>
              <Td>{v.node ? SPACE_LABEL[v.node.space] : 'missing'}</Td>
              <Td>
                {v.node ? (
                  <>
                    {v.degree}
                    <span className="sr-only">
                      {' '}
                      ({v.node.degree_out} out, {v.node.degree_in} in)
                    </span>
                  </>
                ) : (
                  v.degree
                )}
              </Td>
              <Td className="text-muted">{nodeState(v, slug).join(', ') || 'active'}</Td>
              <Td>
                <Button size="sm" variant="ghost" onClick={() => onSelect(v.id)}>
                  Details<span className="sr-only"> of {v.node ? v.node.handle : `[[${v.ref}]]`}</span>
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <Table caption={`Links (${view.edges.length})`} hideCaption={false}>
        <THead>
          <Tr>
            <Th>From</Th>
            <Th>Kind</Th>
            <Th>To</Th>
          </Tr>
        </THead>
        <TBody>
          {view.edges.length === 0 ? (
            <Tr>
              <Td colSpan={3} className="text-muted">
                No links in this view.
              </Td>
            </Tr>
          ) : (
            view.edges.map((e) => {
              const from = byId.get(e.src)
              const to = byId.get(e.dst)
              return (
                <Tr key={e.id}>
                  <Td>{from && <NodeName v={from} />}</Td>
                  <Td className="whitespace-nowrap">{KIND_LABEL[e.kind]}</Td>
                  <Td>{to && <NodeName v={to} />}</Td>
                </Tr>
              )
            })
          )}
        </TBody>
      </Table>
    </div>
  )
}
