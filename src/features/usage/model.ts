// Pure view model for the Usage tab: which series get a colour, how values
// are formatted, and how a bar maps back to a time range for the drill-down.
import type { UsageGranularity, UsageReport, UsageSeries, UsageValues } from '../../../shared/ipc-types'

export const GRANULARITIES: { key: UsageGranularity; label: string; periods: number; span: string }[] = [
  { key: 'hour', label: 'Hour', periods: 48, span: 'last 48 hours' },
  { key: 'day', label: 'Day', periods: 30, span: 'last 30 days' },
  { key: 'week', label: 'Week', periods: 12, span: 'last 12 weeks' },
  { key: 'month', label: 'Month', periods: 12, span: 'last 12 months' },
]

export type Metric = keyof UsageValues

export const METRICS: { key: Metric; label: string }[] = [
  { key: 'processed', label: 'Tokens processed' },
  { key: 'output', label: 'Output tokens' },
  { key: 'activeMinutes', label: 'Active time' },
]

// Six categorical slots (--series-1..6 in usage.css) plus a neutral "Other".
export const SLOT_COUNT = 6
export const OTHER_KEY = '__other'

// The series drawn in their own colour: the top six by the selected metric.
// Everything else folds into "Other" — a seventh hue is never generated.
export function pickSeries(report: UsageReport, metric: Metric): { shown: UsageSeries[]; rest: UsageSeries[] } {
  const ranked = report.series
    .filter((s) => (report.totals[s.key]?.[metric] ?? 0) > 0)
    .sort((a, b) => report.totals[b.key][metric] - report.totals[a.key][metric])
  return { shown: ranked.slice(0, SLOT_COUNT), rest: ranked.slice(SLOT_COUNT) }
}

// Colour follows the entity, not its rank: a key keeps the slot it had while
// it stays on screen, so switching metric or granularity doesn't repaint a
// project that is still shown. New keys take the lowest free slot.
export function assignSlots(keys: string[], prev: ReadonlyMap<string, number>): Map<string, number> {
  const next = new Map<string, number>()
  const used = new Set<number>()
  for (const k of keys) {
    const slot = prev.get(k)
    if (slot !== undefined && !used.has(slot)) {
      next.set(k, slot)
      used.add(slot)
    }
  }
  for (const k of keys) {
    if (next.has(k)) continue
    let slot = 0
    while (used.has(slot)) slot++
    next.set(k, slot)
    used.add(slot)
  }
  // Remember off-screen keys too, so one that comes back gets its old colour
  // if that slot is still free.
  for (const [k, slot] of prev) if (!next.has(k) && !used.has(slot)) next.set(k, slot)
  return next
}

// The CSS class carrying a key's colour (usage.css); unslotted keys are Other.
export function fillClass(key: string, slots: ReadonlyMap<string, number>): string {
  const slot = slots.get(key)
  return key === OTHER_KEY || slot === undefined ? 'usage-fill-other' : `usage-fill-s${slot + 1}`
}

export interface Segment {
  key: string // a series key, or OTHER_KEY
  value: number
}

// One bar: the shown series bottom-up (largest overall at the base), then Other.
export function stackFor(values: Record<string, UsageValues>, shown: UsageSeries[], metric: Metric): Segment[] {
  const shownKeys = new Set(shown.map((s) => s.key))
  const segments = shown.map((s) => ({ key: s.key, value: values[s.key]?.[metric] ?? 0 }))
  let other = 0
  for (const [key, v] of Object.entries(values)) if (!shownKeys.has(key)) other += v[metric]
  segments.push({ key: OTHER_KEY, value: other })
  return segments.filter((s) => s.value > 0)
}

export function fmtTokens(n: number): string {
  const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s) // "5.00" -> "5", "2.50" -> "2.5"
  if (n >= 1e9) return `${trim((n / 1e9).toFixed(n >= 1e10 ? 1 : 2))}B`
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(n >= 1e8 ? 0 : 1))}M`
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}k`
  return String(Math.round(n))
}

export function fmtMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  const rest = Math.round(m % 60)
  return rest ? `${h}h ${rest}m` : `${h}h`
}

export const fmtMetric = (metric: Metric, n: number): string => (metric === 'activeMinutes' ? fmtMinutes(n) : fmtTokens(n))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Axis label for a period, in local time.
export function periodLabel(granularity: UsageGranularity, startIso: string): string {
  const d = new Date(startIso)
  switch (granularity) {
    case 'hour':
      return `${String(d.getHours()).padStart(2, '0')}:00`
    case 'day':
    case 'week':
      return `${MONTHS[d.getMonth()]} ${d.getDate()}`
    case 'month':
      return d.getMonth() === 0 ? `Jan '${String(d.getFullYear()).slice(2)}` : MONTHS[d.getMonth()]
  }
}

// Longer form for tooltips and the drill-down heading.
export function periodTitle(granularity: UsageGranularity, startIso: string): string {
  const d = new Date(startIso)
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  switch (granularity) {
    case 'hour':
      return `${day}, ${String(d.getHours()).padStart(2, '0')}:00`
    case 'day':
      return day
    case 'week':
      return `Week of ${day}`
    case 'month':
      return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  }
}

// Start of the period after the one starting at startIso (local time).
export function nextPeriodStart(granularity: UsageGranularity, startIso: string): string {
  const d = new Date(startIso)
  switch (granularity) {
    case 'hour':
      return new Date(d.getTime() + 3_600_000).toISOString()
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString()
    case 'week':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).toISOString()
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString()
  }
}

// Which x-axis labels to print so they never collide: every nth, always the last.
export function labelStep(granularity: UsageGranularity, count: number): number {
  if (granularity === 'hour') return 6
  return count > 16 ? Math.ceil(count / 8) : 1
}

// Rounded "nice" ceiling for the y axis: 1, 2 or 5 × 10^k.
export function niceCeil(n: number): number {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p
  return 10 * p
}
