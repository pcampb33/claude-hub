import { useUsageLimits } from '../home/reads'
import { clock, formatSpan, paceRows, pct, unavailableText, useMinuteTick } from '../home/widgets/pace/pace'
import { useNavigate } from '../shared/useHashRoute'

// Weekly usage, pinned in the titlebar on every view (2026-11-02, the user's
// call). Same shared read as Home's Pace widget; main caches the endpoint for
// 30 minutes, so the 5-minute refresh here never reaches it. A failed or
// missing reading shows as "?" with the reason, never as nothing.
export function UsageChip() {
  const read = useUsageLimits()
  const now = useMinuteTick(read.refresh)
  const navigate = useNavigate()
  const report = read.status === 'data' ? read.data : null
  const week = report?.available ? paceRows(report, now).find((r) => r.key === 'sevenDay') : undefined

  let text: string
  let title: string
  let tone = ''
  if (read.status === 'loading') {
    text = 'Weekly …'
    title = 'Reading weekly usage…'
  } else if (read.status === 'error') {
    text = 'Weekly ?'
    title = `Couldn't read weekly usage: ${read.error}`
  } else if (!read.data.available) {
    text = 'Weekly ?'
    title = unavailableText(read.data.reason)
  } else if (!week) {
    text = 'Weekly ?'
    title = 'The usage endpoint returned no weekly window for this account.'
  } else {
    const p = week.pace
    text = `Weekly ${pct(p.used)}`
    const outlook =
      p.kind === 'projected'
        ? p.runsOutAt !== null
          ? `runs out ~${clock(p.runsOutAt, true)} at this pace`
          : `on pace for ${pct(p.projected)}`
        : p.kind === 'early'
          ? 'too early to project'
          : 'this reading’s window has reset'
    const resets = p.kind === 'reset' ? '' : ` · resets in ${formatSpan(p.resetsInMs)}`
    const stale = report?.staleAsOf !== undefined ? ` (stale reading from ${clock(report.staleAsOf)})` : ''
    title = `Weekly limit: ${pct(p.used)} used · ${outlook}${resets}${stale}. Click for Usage.`
    tone = p.used >= 0.9 ? ' is-danger' : p.kind === 'projected' && p.runsOutAt !== null ? ' is-warn' : ''
  }

  return (
    <button type="button" className={`titlebar-usage${tone}`} title={title} onClick={() => navigate('usage')}>
      {text}
    </button>
  )
}
