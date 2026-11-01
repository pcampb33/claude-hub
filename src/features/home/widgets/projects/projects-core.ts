import type { Tone } from '../../parts'

// Pure layout and aggregation for the Projects widget: the health × recency
// map, its direct labels, and the 14-day activity grid.

// The map's x axis runs from "now" to 30 days on a log scale; a project whose
// last session is older (or that has none) goes in the "No sessions in 30
// days" chip row instead of being pinned to the right edge.
export const MAP_SPAN_HOURS = 30 * 24
export const HEALTHY = 80

export const hoursSince = (iso: string, nowMs: number) => Math.max(0, (nowMs - Date.parse(iso)) / 3_600_000)

// 0..1 along the log axis.
export const logPos = (hours: number) => Math.log1p(Math.min(hours, MAP_SPAN_HOURS)) / Math.log1p(MAP_SPAN_HOURS)

export const healthTone = (score: number): Tone => (score < 70 ? 'danger' : score < HEALTHY ? 'warn' : 'accent')

// Dot area tracks tokens loaded per session; capped so one huge CLAUDE.md
// does not swallow its neighbours.
export const dotRadius = (tokens: number) => Math.min(14, 3.5 + Math.sqrt(Math.max(0, tokens)) / 9)

// The y axis floor: 50 unless a project scores lower.
export const scoreFloor = (scores: number[]) => Math.min(50, Math.floor(Math.min(...scores, 100) / 10) * 10)

export interface Dot {
  x: number
  y: number
  r: number
  label: string
}

export interface PlacedLabel {
  x: number
  y: number // text baseline
  anchor: 'start' | 'end' | 'middle'
}

type Box = [number, number, number, number] // x0, y0, x1, y1

const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

// Greedy direct labels: each dot, in the order given (put the important ones
// first), takes the first spot (right, left, above, below, then the diagonals)
// that stays inside the chart and clears every dot and every label already
// placed. A dot with no free spot gets no label — its tooltip still names it.
export function placeLabels(dots: Dot[], width: number, height: number, charW = 6.1): (PlacedLabel | null)[] {
  const dotBoxes: Box[] = dots.map((d) => [d.x - d.r, d.y - d.r, d.x + d.r, d.y + d.r])
  const placed: Box[] = []
  return dots.map((d, i) => {
    const w = d.label.length * charW
    const candidates: PlacedLabel[] = [
      { x: d.x + d.r + 4, y: d.y + 3.5, anchor: 'start' },
      { x: d.x - d.r - 4, y: d.y + 3.5, anchor: 'end' },
      { x: d.x, y: d.y - d.r - 4, anchor: 'middle' },
      { x: d.x, y: d.y + d.r + 12, anchor: 'middle' },
      { x: d.x + d.r + 2, y: d.y - d.r - 2, anchor: 'start' },
      { x: d.x + d.r + 2, y: d.y + d.r + 10, anchor: 'start' },
      { x: d.x - d.r - 2, y: d.y - d.r - 2, anchor: 'end' },
      { x: d.x - d.r - 2, y: d.y + d.r + 10, anchor: 'end' },
    ]
    for (const c of candidates) {
      const x0 = c.anchor === 'start' ? c.x : c.anchor === 'end' ? c.x - w : c.x - w / 2
      const box: Box = [x0 - 2, c.y - 10, x0 + w + 2, c.y + 3]
      if (box[0] < 0 || box[2] > width || box[1] < 0 || box[3] > height) continue
      if (placed.some((b) => overlaps(b, box))) continue
      if (dotBoxes.some((b, j) => j !== i && overlaps(b, box))) continue
      placed.push(box)
      return c
    }
    return null
  })
}

// Labels for the 14 activity days, oldest → newest, ending today (the
// activity IPC's own window: local days, today last).
export function dayLabels(nowMs: number, n = 14): string[] {
  const today = new Date(nowMs)
  return Array.from({ length: n }, (_, i) => {
    if (i === n - 1) return 'today'
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i))
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  })
}

export interface ActivityRow {
  id: string
  name: string
  days: number[]
  total: number
}

// Projects with any activity, busiest first, and the per-day totals.
export function activityRows(
  history: { registryId: string; days: number[] }[],
  nameOf: (id: string) => string | undefined,
): { rows: ActivityRow[]; totals: number[] } {
  const n = history[0]?.days.length ?? 14
  const totals = Array.from({ length: n }, (_, i) => history.reduce((a, h) => a + (h.days[i] ?? 0), 0))
  const rows = history
    .map((h) => ({ id: h.registryId, name: nameOf(h.registryId) ?? h.registryId, days: h.days, total: h.days.reduce((a, v) => a + v, 0) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { rows, totals }
}
