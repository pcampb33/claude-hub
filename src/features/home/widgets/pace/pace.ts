import { useEffect, useState } from 'react'
import type { UsageLimitsReport, UsageWindow } from '../../../../../shared/ipc-types'

export const FIVE_HOUR_MS = 5 * 60 * 60_000
export const WEEK_MS = 7 * 24 * 60 * 60_000

// Below this share of the window gone, used/elapsed is noise: 2% used in the
// first 6 minutes of a 5h window "projects" to 100%.
export const MIN_ELAPSED = 0.1

export type WindowPace =
  // The reading's reset is already behind us (a cached or stale report), so
  // its utilization belongs to a window that has ended — nothing to project.
  | { kind: 'reset'; used: number }
  | { kind: 'early'; used: number; elapsed: number; resetsInMs: number }
  // projected is the share of the window's quota used by reset at the pace so
  // far (may exceed 1); runsOutAt is set when it does — the epoch ms the
  // window hits 100% at that pace.
  | { kind: 'projected'; used: number; elapsed: number; resetsInMs: number; projected: number; runsOutAt: number | null }

// Fractions, not percents: used 0.22 = 22% of the window consumed.
export function windowPace(w: UsageWindow, lengthMs: number, now: number): WindowPace {
  const used = Math.max(0, w.utilization) / 100
  const resetsInMs = new Date(w.resetsAt).getTime() - now
  if (!(resetsInMs > 0)) return { kind: 'reset', used }
  const elapsed = Math.min(1, Math.max(0, 1 - resetsInMs / lengthMs))
  if (elapsed < MIN_ELAPSED) return { kind: 'early', used, elapsed, resetsInMs }
  const projected = used / elapsed
  const elapsedMs = elapsed * lengthMs
  const runsOutAt = projected > 1 && used > 0 ? now + ((1 - used) / used) * elapsedMs : null
  return { kind: 'projected', used, elapsed, resetsInMs, projected, runsOutAt }
}

export interface PaceRow {
  key: 'fiveHour' | 'sevenDay' | 'scoped'
  name: string
  window: UsageWindow
  pace: WindowPace
}

// The windows a report carries, in display order. The model-scoped weekly is
// often the binding one, so it is a row of its own, not a footnote.
export function paceRows(report: UsageLimitsReport, now: number): PaceRow[] {
  const rows: PaceRow[] = []
  if (report.fiveHour) rows.push({ key: 'fiveHour', name: '5-hour', window: report.fiveHour, pace: windowPace(report.fiveHour, FIVE_HOUR_MS, now) })
  if (report.sevenDay) rows.push({ key: 'sevenDay', name: 'Weekly', window: report.sevenDay, pace: windowPace(report.sevenDay, WEEK_MS, now) })
  if (report.scopedWeekly)
    rows.push({
      key: 'scoped',
      name: `Weekly · ${report.scopedWeekly.label}`,
      window: report.scopedWeekly,
      pace: windowPace(report.scopedWeekly, WEEK_MS, now),
    })
  return rows
}

// The when-relevant rule: some window is on course past 50% at reset. Only a
// real projection counts — an "early" or already-reset window says nothing.
export function onCoursePastHalf(rows: PaceRow[]): boolean {
  return rows.some((r) => r.pace.kind === 'projected' && r.pace.projected >= 0.5)
}

// "3h 12m", "2d 4h", "45m".
export function formatSpan(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

export function clock(at: number, withDay = false): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return withDay ? `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}` : time
}

export const pct = (f: number) => `${Math.round(f * 100)}%`

// Why a report has no windows, in words — reasons from electron/usage.ts.
export function unavailableText(reason: string | undefined): string {
  if (reason === 'no-credentials') return 'No Claude Code login found. Sign in through Claude Code.'
  if (reason === 'token-expired') return 'The Claude Code login token has expired. Using Claude Code refreshes it.'
  if (reason === 'timeout') return 'The usage endpoint did not answer within 20 seconds.'
  if (reason === 'request-failed') return 'The request to the usage endpoint failed.'
  if (reason === 'http-429') return 'The usage endpoint is rate-limiting this account (HTTP 429).'
  if (reason?.startsWith('http-')) return `The usage endpoint answered HTTP ${reason.slice(5)}.`
  return `The usage endpoint gave no reading${reason ? ` (${reason})` : ''}.`
}

// Elapsed share moves while the reading sits still, so the marker re-renders
// each minute; the read itself refreshes every 5 (main caches the endpoint for
// 30 minutes, so this costs no upstream calls).
export function useMinuteTick(refresh: () => void): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let ticks = 0
    const id = setInterval(() => {
      setNow(Date.now())
      if (++ticks % 5 === 0) refresh()
    }, 60_000)
    return () => clearInterval(id)
  }, [refresh])
  return now
}
