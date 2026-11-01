import type { ReactNode } from 'react'
import { PeekContent } from '../../peek'
import { Actions, Btn, KV, Loading, Sec, StatePill, Unreachable } from '../../parts'
import { useUsageLimits } from '../../reads'
import type { DetailProps } from '../../types'
import { useNavigate } from '../../../shared/useHashRoute'
import { clock, formatSpan, paceRows, pct, unavailableText, useMinuteTick, type PaceRow } from './pace'
import { PaceTrack } from './PaceTrack'
import './pace.css'

function projectionText(row: PaceRow): string {
  const p = row.pace
  if (p.kind === 'reset') return 'none: the window this reading belongs to has reset'
  if (p.kind === 'early') return 'too early to project (under 10% of the window gone)'
  return `about ${pct(p.projected)}`
}

function shortProjection(row: PaceRow): string {
  const p = row.pace
  if (p.kind === 'reset') return 'window has reset'
  if (p.kind === 'early') return 'too early to project'
  return `about ${pct(p.projected)} at reset`
}

function WindowSec({ row, now }: { row: PaceRow; now: number }) {
  const p = row.pace
  const withDay = row.key !== 'fiveHour'
  const resetAt = new Date(row.window.resetsAt).getTime()
  const rows: [ReactNode, ReactNode][] = [
    ['Used', pct(p.used)],
    ['Time elapsed', p.kind === 'reset' ? '—' : pct(p.elapsed)],
    ['Projected at reset', projectionText(row)],
  ]
  if (p.kind === 'projected' && p.runsOutAt !== null)
    rows.push(['Runs out', <span className="tone-warn">~{clock(p.runsOutAt, withDay)} at this pace</span>])
  rows.push([
    p.kind === 'reset' ? 'Reset' : 'Resets',
    Number.isNaN(resetAt)
      ? row.window.resetsAt
      : `${clock(resetAt, withDay)}${resetAt > now ? ` · in ${formatSpan(resetAt - now)}` : ''}`,
  ])
  return (
    <Sec title={`${row.name} window`}>
      <PaceTrack row={row} />
      <KV rows={rows} />
    </Sec>
  )
}

export function PaceDetail({ ctx }: DetailProps) {
  const read = useUsageLimits()
  const now = useMinuteTick(read.refresh)
  const navigate = useNavigate()
  const focus = typeof ctx?.window === 'string' ? ctx.window : null

  let body
  let title = 'Rate-limit pace'
  if (read.status === 'loading') body = <Loading rows={4} />
  else if (read.status === 'error')
    body = <Unreachable what="the usage endpoint" error={read.error} onRetry={read.refresh} />
  else if (!read.data.available)
    body = (
      <Sec title="No usage reading">
        <p>{unavailableText(read.data.reason)}</p>
        <p className="pace-note">Nothing is shown as 0% here: without a reading the hub can’t tell how much quota is left.</p>
      </Sec>
    )
  else {
    const report = read.data
    const all = paceRows(report, now)
    const rows = focus ? all.filter((r) => r.key === focus) : all
    if (focus && rows[0]) title = `${rows[0].name} window`
    body = (
      <>
        {rows.length === 0 ? (
          <Sec>
            <p>The usage endpoint returned no rate-limit windows for this account.</p>
          </Sec>
        ) : (
          rows.map((row) => <WindowSec key={row.key} row={row} now={now} />)
        )}
        {focus && all.length > rows.length && (
          <Sec title="Other windows">
            <KV rows={all.filter((r) => r.key !== focus).map((r) => [r.name, `${pct(r.pace.used)} used · ${shortProjection(r)}`])} />
          </Sec>
        )}
        <Sec title="How it’s projected">
          <div className="pace-legend" aria-hidden="true">
            <span>
              <i className="lg-used" />
              used
            </span>
            <span>
              <i className="lg-proj" />
              at this pace by reset
            </span>
            <span>
              <i className="lg-tick" />
              time gone
            </span>
          </div>
          <p className="pace-note">
            Projected = used ÷ share of the window’s time gone, i.e. the pace so far held until the reset. It isn’t shown
            before 10% of the window has passed, when one busy prompt would swing it wildly. Home shows this widget when a
            projection passes 50%, if its when-relevant rule is on.
          </p>
        </Sec>
        <Sec title="Reading">
          {report.staleAsOf !== undefined ? (
            <p>
              <StatePill tone="unknown">stale</StatePill> Read at {clock(report.staleAsOf, true)},{' '}
              {formatSpan(now - report.staleAsOf)} ago. The latest refresh failed, so the hub is re-serving its last
              good reading; a window may have reset since.
            </p>
          ) : (
            <p className="pace-note">
              Current. Read from the account’s OAuth usage endpoint (the one Claude Code’s /usage reads); the hub asks
              it at most every 30 minutes because the endpoint’s quota is shared with your running sessions.
            </p>
          )}
        </Sec>
      </>
    )
  }

  return (
    <PeekContent crumb="Rate-limit pace" title={title}>
      {body}
      <Sec bare>
        <Actions>
          <Btn kind="primary" onClick={() => navigate('sessions')}>
            Open Sessions
          </Btn>
          <Btn onClick={read.refresh} title="Main re-asks the endpoint only when its 30-minute cache has expired">
            Re-read
          </Btn>
        </Actions>
      </Sec>
    </PeekContent>
  )
}
