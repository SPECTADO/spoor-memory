/**
 * Small hand-written SVG charts (no chart library; ADR-0033). Colours come from the theme tokens (`fill-accent`,
 * `stroke-accent`, …), so light and dark mode follow src/index.css. The SVG stretches to its box
 * (`preserveAspectRatio="none"`, non-scaling strokes) and carries no text; labels are HTML around it, so it
 * never forces horizontal scroll. Every chart has a `<title>` and `<desc>`; the bar chart adds a visually
 * hidden table with every number, the line chart puts current / min / max in its description.
 */
import { useId } from 'react'
import { cx } from './cx'

export interface BarSeries {
  name: string
  /** Fill utility, e.g. `fill-accent`; the legend swatch uses the matching `bg-*` in `swatch`. */
  fill: string
  swatch: string
}

export interface BarDatum {
  label: string
  /** One value per series, stacked bottom-up in series order. */
  values: number[]
}

/** The y-axis top: the largest stack rounded up to 1, 2 or 5 × 10ⁿ. */
export function niceMax(n: number): number {
  if (!(n > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p
  return 10 * p
}

const W = 100
const H = 40

export function StackedBarChart({
  title,
  description,
  series,
  data,
  className,
}: {
  title: string
  description: string
  series: BarSeries[]
  data: BarDatum[]
  className?: string
}) {
  const id = useId()
  const top = niceMax(Math.max(0, ...data.map((d) => d.values.reduce((a, v) => a + v, 0))))
  const slot = W / Math.max(1, data.length)
  const bar = slot * 0.7
  return (
    <figure className={cx('min-w-0', className)}>
      <div className="flex items-stretch gap-2">
        <div className="flex flex-col justify-between text-right text-xs tabular-nums text-muted" aria-hidden>
          <span>{top.toLocaleString('en')}</span>
          <span>0</span>
        </div>
        <svg
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-32 min-w-0 flex-1 border-b border-l border-border"
        >
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description}</desc>
          {data.map((d, i) => {
            let y = H
            return (
              <g key={d.label} data-testid="bar">
                {d.values.map((v, s) => {
                  const h = (v / top) * H
                  y -= h
                  const ser = series[s]
                  if (!ser || h <= 0) return null
                  return (
                    <rect
                      key={ser.name}
                      x={i * slot + (slot - bar) / 2}
                      y={y}
                      width={bar}
                      height={h}
                      className={ser.fill}
                    >
                      <title>{`${d.label}: ${v.toLocaleString('en')} ${ser.name}`}</title>
                    </rect>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-1 flex justify-between pl-6 text-xs text-muted" aria-hidden>
        <span>{data[0]?.label}</span>
        <span>{data.at(-1)?.label}</span>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1">
            <span className={cx('inline-block size-2.5 rounded-sm', s.swatch)} aria-hidden />
            {s.name}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              {series.map((s, i) => (
                <td key={s.name}>{d.values[i] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** Runs of consecutive non-null points as SVG path data; a lone point becomes a dot (zero-length segment). */
export function linePath(values: (number | null)[], lo: number, hi: number): string {
  const n = values.length
  if (n === 0) return ''
  const span = hi - lo || 1
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => H - ((v - lo) / span) * (H - 2) - 1
  const parts: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length === 1) run.push(run[0]?.replace(/^M/, 'L') ?? '')
    if (run.length) parts.push(run.join(' '))
    run = []
  }
  for (const [i, v] of values.entries()) {
    if (v === null || !Number.isFinite(v)) flush()
    else run.push(`${run.length ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
  }
  flush()
  return parts.join(' ')
}

export function LineChart({
  title,
  description,
  values,
  min,
  max,
  className,
}: {
  title: string
  /** The numbers in words (current, min, max, window); read by screen readers. */
  description: string
  values: (number | null)[]
  /** Axis floor (default 0, or the lowest value when that is negative). */
  min?: number
  /** Axis ceiling (default the highest value). */
  max?: number
  className?: string
}) {
  const id = useId()
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const lo = min ?? Math.min(0, ...nums)
  const hi = Math.max(max ?? 0, ...nums, lo + 1e-9)
  const d = linePath(values, lo, hi)
  return (
    <svg
      role="img"
      aria-labelledby={`${id}-t ${id}-d`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cx('h-12 w-full', className)}
    >
      <title id={`${id}-t`}>{title}</title>
      <desc id={`${id}-d`}>{description}</desc>
      <line
        x1={0}
        x2={W}
        y1={H - 0.5}
        y2={H - 0.5}
        className="stroke-border"
        vectorEffect="non-scaling-stroke"
      />
      {d && (
        <path
          d={d}
          fill="none"
          className="stroke-accent"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}
