/** Status of one Markdown-zip task (ADR-0041): a badge, and a plain download link once it is ready. */
import type { ExportTaskJson } from '../api/types'
import { bytes } from '../lib/format'
import { Badge, type BadgeTone, buttonClass } from '../ui'

const TONES: Record<ExportTaskJson['status'], BadgeTone> = {
  queued: 'neutral',
  running: 'accent',
  ready: 'success',
  failed: 'danger',
  expired: 'neutral',
}

const LABELS: Record<ExportTaskJson['status'], string> = {
  queued: 'Queued',
  running: 'Building',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
}

export function ExportTaskStatus({ task }: { task: ExportTaskJson }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={TONES[task.status]}>{LABELS[task.status]}</Badge>
      {task.status === 'ready' && task.download_url && (
        <a
          className={buttonClass('secondary', 'sm')}
          href={task.download_url}
          download={task.file_name ?? true}
        >
          Download{task.file_name ? ` ${task.file_name}` : ''}
          {task.size_bytes !== null ? ` (${bytes(task.size_bytes)})` : ''}
        </a>
      )}
      {task.status === 'failed' && task.error && <span className="text-xs text-danger">{task.error}</span>}
      {task.status === 'expired' && <span className="text-xs text-muted">Prepare it again.</span>}
    </span>
  )
}
