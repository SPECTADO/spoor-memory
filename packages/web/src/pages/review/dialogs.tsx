import { type FormEvent, useState } from 'react'
import { Button, Dialog, Input, Select, Textarea } from '../../ui'

/** Pick an existing memory (by handle) or write a new one; the old memory becomes superseded. */
export function SupersedeDialog({
  open,
  handle,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean
  handle: string
  pending?: boolean
  error?: string
  onClose: () => void
  onSubmit: (v: { newId: string } | { title: string; body: string }) => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Supersede ${handle}`}
      description="The old memory is kept as superseded and links to its replacement."
    >
      <SupersedeForm pending={pending} error={error} onClose={onClose} onSubmit={onSubmit} />
    </Dialog>
  )
}

function SupersedeForm({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending?: boolean
  error?: string
  onClose: () => void
  onSubmit: (v: { newId: string } | { title: string; body: string }) => void
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [newId, setNewId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const valid = mode === 'existing' ? newId.trim() !== '' : title.trim() !== ''
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid || pending) return
    onSubmit(mode === 'existing' ? { newId: newId.trim() } : { title: title.trim(), body })
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Select
        label="Replace with"
        value={mode}
        onChange={(e) => setMode(e.target.value as 'existing' | 'new')}
        options={[
          { value: 'existing', label: 'An existing memory' },
          { value: 'new', label: 'A new memory' },
        ]}
      />
      {mode === 'existing' ? (
        <Input
          label="Handle of the replacement"
          hint="A memory of this project, for example m42."
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      ) : (
        <>
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Textarea label="Body" value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
          Supersede
        </Button>
      </div>
    </form>
  )
}

/** Restoring an expired observation needs it promoted to a fact in the same action. */
export function PromoteRestoreDialog({
  open,
  handle,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean
  handle: string
  pending?: boolean
  error?: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Restore ${handle}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} loading={pending}>
            Promote and restore
          </Button>
        </>
      }
    >
      <p className="text-sm">Its expiry has passed. Promote it to a fact and restore?</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}
