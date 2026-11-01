import { useState } from 'react'
import type { UsageGranularity, UsageReport, UsageSeries } from '../../../shared/ipc-types'
import { fillClass, fmtMetric, labelStep, niceCeil, OTHER_KEY, periodLabel, periodTitle, stackFor, type Metric } from './model'

const W = 1000
const H = 280
const LEFT = 56
const BOTTOM = 22
const TOP = 14
const RIGHT = 24 // room for the last x label
const GAP = 1.5 // surface gap between stacked segments

// A bar's top segment gets rounded corners; the rest are flat so the stack
// reads as one column.
function segmentPath(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(3, w / 2, h) : 0
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
}

export function UsageChart({
  report,
  granularity,
  metric,
  shown,
  names,
  slots,
  onPick,
}: {
  report: UsageReport
  granularity: UsageGranularity
  metric: Metric
  shown: UsageSeries[]
  names: ReadonlyMap<string, string>
  slots: ReadonlyMap<string, number>
  onPick: (key: string, bucketIndex: number) => void
}) {
  const [hover, setHover] = useState<number | null>(null)
  const stacks = report.buckets.map((b) => stackFor(b.values, shown, metric))
  const sums = stacks.map((s) => s.reduce((n, seg) => n + seg.value, 0))
  const top = niceCeil(Math.max(...sums, 0))
  const plotH = H - TOP - BOTTOM
  const band = (W - LEFT - RIGHT) / report.buckets.length
  const bw = Math.max(3, Math.min(34, band * 0.68))
  const y = (v: number) => TOP + plotH - (v / top) * plotH
  const step = labelStep(granularity, report.buckets.length)
  const last = report.buckets.length - 1
  const ticks = [0, 0.5, 1].map((f) => f * top)

  return (
    <div className="usage-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked ${metric} per ${granularity}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'usage-baseline' : 'usage-grid'} x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} />
            <text className="usage-axis" x={LEFT - 8} y={y(t) + 3.5} textAnchor="end">
              {fmtMetric(metric, t)}
            </text>
          </g>
        ))}
        {report.buckets.map((b, i) => {
          const x = LEFT + band * i + (band - bw) / 2
          let base = 0
          const showLabel = i === last || (i % step === 0 && last - i >= step / 2)
          return (
            <g key={b.startIso} onMouseEnter={() => setHover(i)}>
              <rect className={`usage-col-hit${hover === i ? ' is-hover' : ''}`} x={LEFT + band * i} y={TOP} width={band} height={plotH} />
              {stacks[i].map((seg, j) => {
                const y0 = y(base + seg.value)
                const h = y(base) - y0
                base += seg.value
                const isTop = j === stacks[i].length - 1
                const gap = isTop || h <= GAP * 2 ? 0 : GAP
                return (
                  <path
                    key={seg.key}
                    className={`usage-seg ${fillClass(seg.key, slots)}`}
                    d={segmentPath(x, y0 + gap, bw, Math.max(0.5, h - gap), isTop)}
                    onClick={() => onPick(seg.key, i)}
                  />
                )
              })}
              {showLabel && (
                <text className="usage-axis" x={x + bw / 2} y={H - 6} textAnchor="middle">
                  {periodLabel(granularity, b.startIso)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && sums[hover] > 0 && (
        <div
          className="usage-tip"
          style={{ left: `${((LEFT + band * hover + band / 2) / W) * 100}%`, top: `${(y(sums[hover]) / H) * 100}%` }}
          data-side={hover > report.buckets.length / 2 ? 'left' : 'right'}
        >
          <div className="usage-tip-title">{periodTitle(granularity, report.buckets[hover].startIso)}</div>
          {[...stacks[hover]].reverse().map((seg) => (
            <div key={seg.key} className="usage-tip-row">
              <i className={`usage-swatch ${fillClass(seg.key, slots)}`} />
              <span className="usage-tip-name">{seg.key === OTHER_KEY ? 'Other' : names.get(seg.key)}</span>
              <span className="usage-tip-value">{fmtMetric(metric, seg.value)}</span>
            </div>
          ))}
          <div className="usage-tip-row usage-tip-total">
            <span className="usage-tip-name">Total</span>
            <span className="usage-tip-value">{fmtMetric(metric, sums[hover])}</span>
          </div>
          <div className="usage-tip-hint">Click a segment for its sessions</div>
        </div>
      )}
    </div>
  )
}
