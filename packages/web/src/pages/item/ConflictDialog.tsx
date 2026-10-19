/**
 * `ConflictDialog` (web-ui.md §5.3): a save hit 409 `revision_conflict`. Never last-write-wins: the user
 * sees who saved the newer revision and chooses to compare, keep editing, save their changes over the newer
 * revision (fields they did not change keep the newer values), or discard theirs and reload.
 */
import { useState } from 'react'
import type { ItemJson } from '../../api/types'
import { dateTime } from '../../lib/format'
import { Button, Dialog, DiffView } from '../../ui'
import { When } from './common'

export interface ConflictDialogProps {
  open: boolean
  current: ItemJson | null
  /** The revision the form was based on. */
  baseRevision: number
  mine: { title: string; body: string }
  pending?: boolean
  onKeepEditing: () => void
  onOverwrite: () => void
  onDiscard: () => void
}

export function ConflictDialog({
  open,
  current,
  baseRevision,
  mine,
  pending,
  onKeepEditing,
  onOverwrite,
  onDiscard,
}: ConflictDialogProps) {
  const [compare, setCompare] = useState(false)
  if (!current) return null
  const who = [current.updated_by, current.client_name ? `via ${current.client_name}` : null]
    .filter(Boolean)
    .join(' ')
  return (
    <Dialog
      open={open}
      onClose={() => {
        setCompare(false)
        onKeepEditing()
      }}
      size="lg"
      title="Someone saved a newer version"
      description={
        <>
          {current.handle} is now r{current.revision}, saved by {who} <When iso={current.updated_at} /> (
          {dateTime(current.updated_at)}). You were editing r{baseRevision}.
        </>
      }
      footer={
        <>
          <Button
            onClick={() => {
              setCompare(false)
              onKeepEditing()
            }}
            autoFocus
          >
            Keep editing
          </Button>
          <Button variant="danger" onClick={onDiscard} disabled={pending}>
            Discard mine
          </Button>
          <Button variant="primary" onClick={onOverwrite} loading={pending}>
            Save my version over r{current.revision}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>
            <span className="text-fg">Keep editing</span>: your text stays; the next save conflicts again.
          </li>
          <li>
            <span className="text-fg">Save my version over r{current.revision}</span>: your changes are
            applied to r{current.revision}; fields you did not change keep its values.
          </li>
          <li>
            <span className="text-fg">Discard mine</span>: reload r{current.revision} into the form.
          </li>
        </ul>
        {current.title !== mine.title.trim() && (
          <p>
            Title: <span className="font-medium">{current.title}</span> (theirs) →{' '}
            <span className="font-medium">{mine.title.trim()}</span> (yours)
          </p>
        )}
        <Button size="sm" aria-expanded={compare} onClick={() => setCompare((c) => !c)}>
          {compare ? 'Hide comparison' : 'Compare'}
        </Button>
        {compare && (
          <DiffView
            oldText={current.body}
            newText={mine.body}
            oldLabel={`r${current.revision} (theirs)`}
            newLabel="your edit"
          />
        )}
      </div>
    </Dialog>
  )
}
