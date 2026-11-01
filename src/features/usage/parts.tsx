import type { UsageReport, UsageSeries } from '../../../shared/ipc-types'
import { fillClass, fmtMetric, fmtMinutes, fmtTokens, OTHER_KEY, type Metric } from './model'

export function Toggle<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { key: K; label: string }[]
  value: K
  onChange: (k: K) => void
}) {
  return (
    <div className="usage-toggle" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.key} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function IndexingProgress({ progress }: { progress?: { done: number; total: number } }) {
  const pct = progress && progress.total > 0 ? Math.min(100, (100 * progress.done) / progress.total) : 0
  return (
    <div className="usage-indexing" role="status">
      <div className="usage-indexing-text">
        Indexing your transcripts — first build only.{' '}
        {progress && progress.total > 0
          ? `${Math.round(pct)}% (${(progress.done / 1e6).toFixed(0)} of ${(progress.total / 1e6).toFixed(0)} MB)`
          : 'Listing files…'}{' '}
        The chart appears when it finishes; partial totals aren't shown.
      </div>
      <div className="usage-progress" aria-hidden="true">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// One sentence answering "what's eating my quota" for the window on screen.
export function Headline({ report, span }: { report: UsageReport; span: string }) {
  const keys = Object.keys(report.totals)
  const processed = keys.reduce((n, k) => n + report.totals[k].processed, 0)
  const output = keys.reduce((n, k) => n + report.totals[k].output, 0)
  const active = keys.reduce((n, k) => n + report.totals[k].activeMinutes, 0)
  const lead = report.series[0]
  return (
    <p className="usage-headline">
      <em>{fmtTokens(processed)}</em> tokens processed in the {span} · <em>{fmtTokens(output)}</em> output ·{' '}
      <em>{fmtMinutes(active)}</em> active
      {lead && processed > 0 && (
        <>
          {' '}
          · largest: <em>{lead.name}</em> ({((100 * report.totals[lead.key].processed) / processed).toFixed(0)}%)
        </>
      )}
    </p>
  )
}

export function Legend({
  report,
  metric,
  shown,
  rest,
  slots,
  onPick,
}: {
  report: UsageReport
  metric: Metric
  shown: UsageSeries[]
  rest: UsageSeries[]
  slots: ReadonlyMap<string, number>
  onPick: (s: UsageSeries) => void
}) {
  const otherTotal = rest.reduce((n, s) => n + report.totals[s.key][metric], 0)
  return (
    <ul className="usage-legend">
      {shown.map((s) => (
        <li key={s.key}>
          <button type="button" onClick={() => onPick(s)} title={`${s.name}: show sessions`}>
            <i className={`usage-swatch ${fillClass(s.key, slots)}`} />
            <span className="usage-legend-name">{s.name}</span>
            <span className="usage-legend-value">{fmtMetric(metric, report.totals[s.key][metric])}</span>
          </button>
        </li>
      ))}
      {rest.length > 0 && (
        <li title={rest.map((s) => s.name).join(', ')}>
          <span className="usage-legend-static">
            <i className={`usage-swatch ${fillClass(OTHER_KEY, slots)}`} />
            <span className="usage-legend-name">Other ({rest.length})</span>
            <span className="usage-legend-value">{fmtMetric(metric, otherTotal)}</span>
          </span>
        </li>
      )}
    </ul>
  )
}
