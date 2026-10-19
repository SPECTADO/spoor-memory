/** Dialogs of the item view: add relation, supersede (memories), promote-and-restore an expired observation. */
import { type FormEvent, useState } from 'react'
import { useAddEdge, useRestoreItem, useSupersedeItem } from '../../api/hooks'
import type { Confidence, ItemJson, MemoryType, RelationKind, SupersedeBody } from '../../api/types'
import { isShared } from '../../lib/paths'
import { Alert, Button, Dialog, errorText, Input, Select, Textarea, useToast } from '../../ui'
import { SPACES } from './common'
import { CONFIDENCES, MEMORY_TYPES } from './editorModel'
import { ItemPicker, type PickedTarget } from './ItemPicker'

export const RELATION_KINDS: readonly RelationKind[] = ['refines', 'supports', 'depends_on', 'conflicts_with']
export const RELATION_LABEL: Record<RelationKind, string> = {
  refines: 'refines',
  supports: 'supports',
  depends_on: 'depends on',
  conflicts_with: 'conflicts with',
}

interface ItemDialogProps {
  open: boolean
  onClose: () => void
  slug: string
  item: ItemJson
}

export function RelationDialog({ open, onClose, slug, item }: ItemDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`Add a relation from ${item.handle}`} size="md">
      <RelationForm slug={slug} item={item} onDone={onClose} />
    </Dialog>
  )
}

function RelationForm({ slug, item, onDone }: { slug: string; item: ItemJson; onDone: () => void }) {
  const toast = useToast()
  const add = useAddEdge(slug)
  const [kind, setKind] = useState<RelationKind>('refines')
  const [target, setTarget] = useState<PickedTarget | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!target) return
    add.mutate(
      { ref: item.handle, kind, to: target.ref },
      {
        onSuccess: () => {
          toast.success(`${item.handle} ${RELATION_LABEL[kind]} ${target.ref}`)
          onDone()
        },
      },
    )
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Select
        label="Kind"
        value={kind}
        options={RELATION_KINDS.map((k) => ({ value: k, label: RELATION_LABEL[k] }))}
        onChange={(e) => setKind(e.target.value as RelationKind)}
      />
      <ItemPicker
        slug={slug}
        spaces={SPACES}
        allowShared={!isShared(slug)}
        excludeId={item.id}
        value={target}
        onChange={setTarget}
      />
      {add.isError && (
        <Alert tone="danger" title={errorText(add.error).message}>
          {errorText(add.error).detail}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!target} loading={add.isPending}>
          Add relation
        </Button>
      </div>
    </form>
  )
}

export function SupersedeDialog({ open, onClose, slug, item }: ItemDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Supersede ${item.handle}`}
      description="The old memory stays readable, marked superseded, and leaves the digest."
      size="lg"
    >
      <SupersedeForm slug={slug} item={item} onDone={onClose} />
    </Dialog>
  )
}

function SupersedeForm({ slug, item, onDone }: { slug: string; item: ItemJson; onDone: () => void }) {
  const toast = useToast()
  const supersede = useSupersedeItem(slug)
  const [how, setHow] = useState<'existing' | 'new'>('existing')
  const [target, setTarget] = useState<PickedTarget | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [type, setType] = useState<MemoryType>((item.type as MemoryType | null) ?? 'fact')
  const [reason, setReason] = useState('')
  const ready = how === 'existing' ? target !== null : title.trim().length > 0

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    const req: SupersedeBody = { revision: item.revision }
    if (how === 'existing' && target) req.new_id = target.ref
    else
      req.new = {
        title: title.trim(),
        body,
        type,
        confidence: (CONFIDENCES as readonly string[]).includes(item.confidence ?? '')
          ? (item.confidence as Confidence)
          : 'medium',
        tags: item.tags,
        anchors: item.anchors,
      }
    if (reason.trim()) req.reason = reason.trim()
    supersede.mutate(
      { ref: item.handle, body: req },
      {
        onSuccess: (res) => {
          toast.success(`${item.handle} is superseded by ${res.new.handle}`)
          onDone()
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Replacement</legend>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="how"
            className="accent-[var(--c-accent)]"
            checked={how === 'existing'}
            onChange={() => setHow('existing')}
          />
          Pick an existing memory
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="radio"
            name="how"
            className="accent-[var(--c-accent)]"
            checked={how === 'new'}
            onChange={() => setHow('new')}
          />
          Write a new one
        </label>
      </fieldset>
      {how === 'existing' ? (
        <ItemPicker
          slug={slug}
          spaces={['memories']}
          allowShared={false}
          excludeId={item.id}
          value={target}
          onChange={setTarget}
          legend="Replacement memory"
        />
      ) : (
        <div className="space-y-3">
          <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Select
            label="Type"
            value={type}
            options={MEMORY_TYPES.map((t) => ({ value: t, label: t }))}
            onChange={(e) => setType(e.target.value as MemoryType)}
          />
          <Textarea
            label="Body"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            hint="Markdown. Tags and anchors are copied from the old memory."
            inputClassName="font-mono"
          />
        </div>
      )}
      <Input
        label="Reason (optional)"
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
      />
      {supersede.isError && (
        <Alert tone="danger" title={errorText(supersede.error).message}>
          {errorText(supersede.error).detail}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={supersede.isPending}>
          Supersede
        </Button>
      </div>
    </form>
  )
}

/** An archived observation whose expiry passed can only come back as a fact (api.md §5.3). */
export function PromoteRestoreDialog({ open, onClose, slug, item }: ItemDialogProps) {
  const toast = useToast()
  const restore = useRestoreItem(slug)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Restore ${item.handle}?`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={restore.isPending}
            onClick={() =>
              restore.mutate(
                { ref: item.handle, body: { promote_to_fact: true, revision: item.revision } },
                {
                  onSuccess: (res) => {
                    toast.success(`Restored ${res.item.handle} as a fact`)
                    onClose()
                  },
                  onError: (e) => toast.error(e),
                },
              )
            }
          >
            Promote and restore
          </Button>
        </>
      }
    >
      <p className="text-sm">Its expiry has passed. Promote it to a fact and restore?</p>
    </Dialog>
  )
}
