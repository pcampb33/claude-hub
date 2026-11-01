import type { KeyboardEvent, ReactNode } from 'react'
import type { Tone } from './parts'
import './charts.css'

// Small single-hue SVG charts for the Projects and Live widgets: --accent
// marks, --text-faint for the muted ones, direct labels instead of legends.
// Classes (styled in projects.css) carry the colours so every theme works.

export type Target = {
  role: 'button'
  tabIndex: number
  'aria-label': string
  onClick: (e: { stopPropagation: () => void }) => void
  onKeyDown: (e: KeyboardEvent) => void
}

// A peek's top row: up to three big figures, each with a caption.
export function Hero({ cells }: { cells: { value: ReactNode; caption: ReactNode; tone?: Tone }[] }) {
  return (
    <div className="hc-hero">
      {cells.map((c, i) => (
        <div key={i}>
          <div className={`big${c.tone ? ` tone-${c.tone}` : ''}`}>{c.value}</div>
          <div className="sub">{c.caption}</div>
        </div>
      ))}
    </div>
  )
}

// Columns with a baseline, the highlighted one solid and the rest faded.
export function Columns({
  values,
  labels,
  w,
  h,
  label,
  highlight,
  labelEvery = 1,
  fmt = String,
  min = 0,
  max,
  peak,
  target,
}: {
  values: number[]
  labels: string[]
  w: number
  h: number
  label: string
  highlight?: number
  labelEvery?: number
  fmt?: (v: number) => string
  min?: number
  max?: number
  peak?: boolean
  target?: (i: number) => Target
}) {
  const base = 18
  const band = w / values.length
  const bw = Math.min(26, band * 0.62)
  const top = max ?? Math.max(...values, 1)
  const peakIdx = peak ? values.indexOf(Math.max(...values)) : -1
  return (
    <svg className="hc-cols" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <line className="hc-grid" x1={0} x2={w} y1={h - base} y2={h - base} />
      {values.map((v, i) => {
        const bh = Math.max(2, ((v - min) / (top - min || 1)) * (h - base - 18))
        const x = band * i + (band - bw) / 2
        const y = h - base - bh
        const r = Math.min(4, bw / 2)
        const last = i === values.length - 1
        const showLabel = labelEvery === 1 || last || (i % labelEvery === 0 && i < values.length - 2)
        return (
          <g key={i}>
            <path
              className={`hc-col${highlight != null && i !== highlight ? ' hc-col-faded' : ''}`}
              d={`M${x},${h - base} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${h - base} Z`}
            >
              <title>{`${labels[i]}: ${fmt(v)}`}</title>
            </path>
            {showLabel && (
              <text className="hc-axis" x={x + bw / 2} y={h - 4} textAnchor="middle">
                {labels[i]}
              </text>
            )}
            {i === peakIdx && (
              <text className="hc-value" x={x + bw / 2} y={y - 5} textAnchor="middle">
                {fmt(v)}
              </text>
            )}
            {target && <rect className="hc-hit" x={band * i} y={0} width={band} height={h - base} {...target(i)} />}
          </g>
        )
      })}
    </svg>
  )
}

// Horizontal bars with the label left and the value at the bar's end.
export function HBars({
  rows,
  w,
  labelW = 112,
  label,
}: {
  rows: { label: string; value: number; target?: Target }[]
  w: number
  labelW?: number
  label: string
}) {
  const rowH = 24
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <svg className="hc-hbars" viewBox={`0 0 ${w} ${rows.length * rowH + 4}`} role="img" aria-label={label}>
      {rows.map((r, i) => {
        const y = i * rowH + 2
        const bw = Math.max(3, (r.value / max) * (w - labelW - 40))
        return (
          <g key={r.label}>
            <text className="hc-label" x={0} y={y + 14}>
              {r.label.length > 18 ? `${r.label.slice(0, 17)}…` : r.label}
            </text>
            <rect className="hc-bar" x={labelW} y={y + 5} width={bw} height={12} rx={4} />
            <text className="hc-value" x={labelW + bw + 6} y={y + 14}>
              {r.value}
            </text>
            {r.target && <rect className="hc-hit" x={0} y={y} width={w} height={rowH} {...r.target} />}
          </g>
        )
      })}
    </svg>
  )
}
