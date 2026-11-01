import { useWidgetMeta, useRelevance } from '../../frame-context'
import { usePeekTarget } from '../../peek-context'
import { useUsageLimits } from '../../reads'
import { Empty, Loading, Unreachable } from '../../parts'
import { clock, onCoursePastHalf, paceRows, pct, unavailableText, useMinuteTick } from './pace'
import { PaceCaption, PaceTrack } from './PaceTrack'
import './pace.css'

export function PaceWidget() {
  const read = useUsageLimits()
  const now = useMinuteTick(read.refresh)
  const peekTarget = usePeekTarget()
  const report = read.status === 'data' ? read.data : null
  const rows = report?.available ? paceRows(report, now) : []

  // null while loading, on error, and when the endpoint gave no reading: a
  // widget that can't see the quota must stay on the board and say so.
  useRelevance(report?.available ? onCoursePastHalf(rows) : null)
  useWidgetMeta(report?.staleAsOf !== undefined ? `stale · read ${clock(report.staleAsOf)}` : null)

  if (read.status === 'loading') return <Loading rows={2} />
  if (read.status === 'error') return <Unreachable what="the usage endpoint" error={read.error} onRetry={read.refresh} />
  if (!read.data.available)
    return (
      <div className="pace-unavailable" role="status">
        <b>No usage reading</b>
        <span>{unavailableText(read.data.reason)}</span>
      </div>
    )
  if (rows.length === 0) return <Empty title="No rate-limit windows">The usage endpoint returned none for this account.</Empty>

  return (
    <div className="pace-rows">
      {rows.map((row) => (
        <div key={row.key} className="pace-row" {...peekTarget('pace', { window: row.key }, `${row.name} window details`)}>
          <div className="pace-head">
            <span>{row.name}</span>
            <b>{pct(row.pace.used)} used</b>
          </div>
          <PaceTrack row={row} />
          <PaceCaption row={row} clockFn={(at) => clock(at, row.key !== 'fiveHour')} />
        </div>
      ))}
    </div>
  )
}
