import type { UsageReport, UsageSeries } from '../../../shared/ipc-types'
import { fillClass, fmtMetric, fmtMinutes, fmtTokens, type Metric } from './model'

// Per-period bars for one key; the selected metric, own scale.
function Spark({ values, cls }: { values: number[]; cls: string }) {
  const w = 96
  const h = 22
  const max = Math.max(...values, 1)
  const band = w / values.length
  const bw = Math.max(1, band - (values.length > 24 ? 0.5 : 1.5))
  return (
    <svg className="usage-trend" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      {values.map((v, i) =>
        v > 0 ? <rect key={i} className={cls} x={i * band} y={h - Math.max(1.5, (v / max) * h)} width={bw} height={Math.max(1.5, (v / max) * h)} rx={0.5} /> : null,
      )}
    </svg>
  )
}

export function UsageTable({
  report,
  metric,
  slots,
  selectedKey,
  onPick,
}: {
  report: UsageReport
  metric: Metric
  slots: ReadonlyMap<string, number>
  selectedKey: string | null
  onPick: (series: UsageSeries) => void
}) {
  const rows = [...report.series]
    .sort((a, b) => report.totals[b.key][metric] - report.totals[a.key][metric])
  const sum = rows.reduce((n, s) => n + report.totals[s.key][metric], 0)
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th scope="col">Where</th>
          <th scope="col" className="num">
            Share
          </th>
          <th scope="col" className="num">
            Processed
          </th>
          <th scope="col" className="num">
            Output
          </th>
          <th scope="col" className="num">
            Active
          </th>
          <th scope="col" className="num">
            Sessions
          </th>
          <th scope="col">Trend</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const t = report.totals[s.key]
          const cls = fillClass(s.key, slots)
          return (
            <tr
              key={s.key}
              className={selectedKey === s.key ? 'is-selected' : undefined}
              tabIndex={0}
              onClick={() => onPick(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick(s)
                }
              }}
              aria-label={`${s.name}: show sessions`}
            >
              <td>
                <div className="usage-where">
                  <i className={`usage-swatch ${cls}`} />
                  <span title={s.name}>{s.name}</span>
                </div>
              </td>
              <td className="num">{sum > 0 ? `${((100 * t[metric]) / sum).toFixed(1)}%` : '—'}</td>
              <td className="num">{fmtTokens(t.processed)}</td>
              <td className="num">{fmtTokens(t.output)}</td>
              <td className="num">{fmtMinutes(t.activeMinutes)}</td>
              <td className="num">{t.sessions}</td>
              <td>
                <Spark values={report.buckets.map((b) => b.values[s.key]?.[metric] ?? 0)} cls={cls} />
              </td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td className="num">{rows.length ? '100%' : '—'}</td>
          <td className="num">{fmtTokens(rows.reduce((n, s) => n + report.totals[s.key].processed, 0))}</td>
          <td className="num">{fmtTokens(rows.reduce((n, s) => n + report.totals[s.key].output, 0))}</td>
          <td className="num">{fmtMetric('activeMinutes', rows.reduce((n, s) => n + report.totals[s.key].activeMinutes, 0))}</td>
          <td className="num">{rows.reduce((n, s) => n + report.totals[s.key].sessions, 0)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  )
}
