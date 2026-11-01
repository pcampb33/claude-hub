import type { FloorDayStatus, GlobalAutomation, GlobalItemState, JobFreshness, JobSpendWindow } from '../../../../../shared/ipc-types'
import type { Tone } from '../../parts'

// Pure helpers behind the Automation widget: where each scheduled job sits on
// the 24-hour dial, which freshness probe belongs to which automation, and the
// words for the head's meta line.

// A grade is a verdict on whether the thing did its job. `unknown` stays
// uncoloured: a probe that could not tell is not a finding.
export function gradeTone(state: GlobalItemState): Tone {
  return state === 'ok' ? 'ok' : state === 'attention' ? 'warn' : 'unknown'
}

export function gradeWord(state: GlobalItemState): string {
  return state === 'ok' ? 'ok' : state === 'attention' ? 'needs attention' : 'unknown'
}

// Scheduled rows are named after their Task Scheduler task, all of which
// share the hub's enumeration prefix — noise on a 280px card.
// Hook labels carry their event in parentheses ("Curate hook (SessionEnd)"),
// which the peek shows as the trigger anyway.
export function shortLabel(a: GlobalAutomation): string {
  const s = a.label.replace(/^claude-hub\s+/i, '').replace(/\s*\([^)]*\)$/, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// A log line minus the timestamp and pid every line starts with — in a list
// of rows each already showing "2h ago", that prefix is all anyone would read.
export function logGist(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, '').replace(/^\[pid \d+\]\s*/, '')
}

// global-config hands every probed automation a log id of `log:<probe id>`,
// the same id job-freshness reports under — the only join between the two.
export function freshnessFor(a: GlobalAutomation, freshness: JobFreshness[] | undefined): JobFreshness | null {
  if (!freshness || !a.logId?.startsWith('log:')) return null
  const id = a.logId.slice(4)
  return freshness.find((f) => f.id === id) ?? null
}

// The hour (0..24, fractional) a scheduled job runs at. The scheduler's
// trigger text is the job's NEXT run, formatted in this machine's locale
// ("next Sat 4:30 AM" / "next Sat 04:30"), so it is parsed first; failing
// that, the time of day of the last start. null = nothing says when it runs,
// and the job is listed beside the dial rather than placed on a guess.
export function runHour(a: GlobalAutomation): { hour: number; from: 'schedule' | 'last run' } | null {
  const m = a.trigger.match(/(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]?/) ?? a.trigger.match(/(\d{1,2}):(\d{2})/)
  if (m) {
    let h = Number(m[1]) % 24
    const ap = m[3]?.toLowerCase()
    if (ap === 'p' && h < 12) h += 12
    if (ap === 'a' && h === 12) h = 0
    return { hour: h + Number(m[2]) / 60, from: 'schedule' }
  }
  if (a.lastRunIso) {
    const d = new Date(a.lastRunIso)
    if (!Number.isNaN(d.getTime())) return { hour: d.getHours() + d.getMinutes() / 60, from: 'last run' }
  }
  return null
}

export function hourText(hour: number): string {
  const h = Math.floor(hour)
  const m = Math.round((hour - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export interface DialDot {
  a: GlobalAutomation
  hour: number
  x: number
  y: number
}

// Dots on a ring of radius r around (cx, cy). Two jobs within `minGapHours`
// of each other (the linker at 04:30, verify at 04:45) would sit on top of
// each other and only one could be clicked, so the later one steps inward.
export function dialPlacements(
  jobs: { a: GlobalAutomation; hour: number }[],
  cx: number,
  cy: number,
  r: number,
  inset: number,
  minGapHours = 1,
): DialDot[] {
  const sorted = [...jobs].sort((p, q) => p.hour - q.hour)
  let prevHour = -Infinity
  let prevInner = false
  return sorted.map(({ a, hour }) => {
    const inner = hour - prevHour < minGapHours && !prevInner
    prevInner = inner
    prevHour = hour
    const rr = inner ? r - inset : r
    const ang = (hour / 24) * 2 * Math.PI - Math.PI / 2
    return { a, hour, x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) }
  })
}

// Minutes from `now` until `hour` next comes round on the clock face.
export function cycleMinutes(hour: number, now: Date): number {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return (((Math.round(hour * 60) - nowMin) % 1440) + 1440) % 1440
}

// Minutes from `now` until a job's daily time comes round, but only when the
// scheduler's own next-run text agrees on the weekday: a job that is not
// daily would otherwise get a confident, wrong countdown.
export function minutesUntil(a: GlobalAutomation, hour: number, now: Date): number | null {
  const mins = cycleMinutes(hour, now)
  const day = a.trigger.match(/^next\s+(\S+)/)?.[1]
  if (!day) return null
  const at = new Date(now.getTime() + mins * 60_000)
  return at.toLocaleString(undefined, { weekday: 'short' }) === day ? mins : null
}

export function durationText(mins: number): string {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// The head's meta line: what a glance most needs, worst first.
export function gradeSummary(automations: GlobalAutomation[]): string {
  const attention = automations.filter((a) => a.state === 'attention').length
  const unknown = automations.filter((a) => a.state === 'unknown').length
  if (attention) return `${attention} need${attention === 1 ? 's' : ''} attention`
  if (unknown) return `${unknown} unknown`
  return automations.length ? 'all working' : 'none set up'
}

// One spend window in words. Runs logged `cost=n/a` are named, because the
// dollar figure is then a floor, not the total.
export function spendText(w: JobSpendWindow): string {
  if (w.runs === 0) return '$0.00 · no paid runs'
  const unknown = w.unknownCostRuns ? `, ${w.unknownCostRuns} of unknown cost` : ''
  return `$${w.usd.toFixed(2)} · ${w.runs} run${w.runs === 1 ? '' : 's'}${unknown}`
}

export function msText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : durationText(Math.round(ms / 60_000))
}

export function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function floorDayWord(status: FloorDayStatus): string {
  return status === 'green' ? 'passed' : status === 'red' ? 'failed' : 'no run'
}

// "Mon, Oct 13" from a floor day's YYYY-MM-DD, read as a local date (a bare
// date string parses as UTC midnight, which is the day before west of UTC).
export function floorDayText(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
