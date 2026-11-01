// Session Desktop stage layout: presets, resizable tracks, swap, maximize and
// what may sit on the stage. Pure (no React, no DOM, no hubApi), so
// `node --test` covers it directly.
import type { DesktopSession, OutsideSession } from '../../../shared/ipc-types.ts'
import { dockOrder } from './desktop-model.ts'

// ---- Presets ----------------------------------------------------------------

export type PresetKey = 'focus' | 'split' | 'cols3' | 'main-stack' | 'grid4' | 'grid6'

// A tile position: its column and row (0-based) and how many it spans.
export interface CellPlace {
  col: number
  row: number
  colSpan: number
  rowSpan: number
}

export interface Preset {
  key: PresetKey
  label: string
  cols: number
  rows: number
  cells: CellPlace[] // one per tile position, in onStage order
  // The columns [from, to) a row gutter runs across: in Main + stack it only
  // divides the stacked right-hand column.
  rowGutterCols: [number, number]
}

const at = (col: number, row: number, colSpan = 1, rowSpan = 1): CellPlace => ({ col, row, colSpan, rowSpan })

export const PRESETS: Preset[] = [
  { key: 'focus', label: 'Focus', cols: 1, rows: 1, cells: [at(0, 0)], rowGutterCols: [0, 1] },
  { key: 'split', label: 'Split', cols: 2, rows: 1, cells: [at(0, 0), at(1, 0)], rowGutterCols: [0, 2] },
  { key: 'cols3', label: '3 columns', cols: 3, rows: 1, cells: [at(0, 0), at(1, 0), at(2, 0)], rowGutterCols: [0, 3] },
  {
    key: 'main-stack',
    label: 'Main + stack',
    cols: 2,
    rows: 2,
    cells: [at(0, 0, 1, 2), at(1, 0), at(1, 1)],
    rowGutterCols: [1, 2],
  },
  { key: 'grid4', label: 'Grid 2×2', cols: 2, rows: 2, cells: [at(0, 0), at(1, 0), at(0, 1), at(1, 1)], rowGutterCols: [0, 2] },
  {
    key: 'grid6',
    label: 'Grid 3×2',
    cols: 3,
    rows: 2,
    cells: [at(0, 0), at(1, 0), at(2, 0), at(0, 1), at(1, 1), at(2, 1)],
    rowGutterCols: [0, 3],
  },
]

export const PRESET: Record<PresetKey, Preset> = Object.fromEntries(PRESETS.map((p) => [p.key, p])) as Record<PresetKey, Preset>

export function isPresetKey(value: unknown): value is PresetKey {
  return typeof value === 'string' && value in PRESET
}

export const capacityOf = (key: PresetKey): number => PRESET[key].cells.length

// ---- Tracks -----------------------------------------------------------------
// The stage is a CSS grid whose gutters are real tracks between the tile
// tracks: column c sits on grid track 2c+1 and the gutter after it on 2c+2.
// That keeps placement integer-only and lets a gutter span exactly the cells
// it separates.

export const GUTTER_PX = 12

// Fractions of the free space, one per column / row, summing to 1.
export interface Tracks {
  cols: number[]
  rows: number[]
}
export type TrackMap = Partial<Record<PresetKey, Tracks>>

export const evenTracks = (n: number): number[] => Array.from({ length: n }, () => 1 / n)

export function tracksFor(map: TrackMap, key: PresetKey): Tracks {
  const p = PRESET[key]
  return map[key] ?? { cols: evenTracks(p.cols), rows: evenTracks(p.rows) }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000

// grid-template-columns / -rows: tile tracks interleaved with gutter tracks.
export function trackTemplate(fracs: number[], gutterPx = GUTTER_PX): string {
  return fracs.map((f) => `minmax(0, ${round(f)}fr)`).join(` ${gutterPx}px `)
}

export function cellArea(place: CellPlace): { gridColumn: string; gridRow: string } {
  return {
    gridColumn: `${2 * place.col + 1} / span ${2 * place.colSpan - 1}`,
    gridRow: `${2 * place.row + 1} / span ${2 * place.rowSpan - 1}`,
  }
}

export interface Gutter {
  axis: 'cols' | 'rows'
  index: number // the boundary after track `index`
  gridColumn: string
  gridRow: string
}

export function gutters(key: PresetKey): Gutter[] {
  const p = PRESET[key]
  const out: Gutter[] = []
  for (let i = 0; i < p.cols - 1; i++) out.push({ axis: 'cols', index: i, gridColumn: `${2 * i + 2}`, gridRow: '1 / -1' })
  const [from, to] = p.rowGutterCols
  for (let i = 0; i < p.rows - 1; i++) out.push({ axis: 'rows', index: i, gridColumn: `${2 * from + 1} / ${2 * to}`, gridRow: `${2 * i + 2}` })
  return out
}

// The smallest share a track may shrink to: minPx of the space the tracks
// share, never more than an even split (a tiny stage can't honour minPx).
export function minFraction(minPx: number, availablePx: number, count: number): number {
  if (availablePx <= 0) return 1 / count
  return Math.min(minPx / availablePx, 1 / count)
}

// Moves the boundary after track `index` by `delta` (a share of the whole),
// keeping both neighbours at least `min`. The other tracks don't move.
export function resizeTracks(fracs: number[], index: number, delta: number, min: number): number[] {
  if (index < 0 || index >= fracs.length - 1 || !Number.isFinite(delta)) return fracs
  const pair = fracs[index] + fracs[index + 1]
  const lo = Math.min(min, pair / 2)
  const nextA = Math.min(Math.max(fracs[index] + delta, lo), pair - lo)
  return fracs.map((f, i) => (i === index ? nextA : i === index + 1 ? pair - nextA : f))
}

export function setTracks(map: TrackMap, key: PresetKey, axis: 'cols' | 'rows', fracs: number[]): TrackMap {
  return { ...map, [key]: { ...tracksFor(map, key), [axis]: fracs } }
}

// Double-clicking a gutter evens out that axis again.
export function resetAxis(map: TrackMap, key: PresetKey, axis: 'cols' | 'rows'): TrackMap {
  return setTracks(map, key, axis, evenTracks(PRESET[key][axis]))
}

// ---- Arranging tiles ----------------------------------------------------------

// Dragging tile i onto tile j swaps their positions.
export function swapCells(onStage: string[], i: number, j: number): string[] {
  if (i === j || i < 0 || j < 0 || i >= onStage.length || j >= onStage.length) return onStage
  const next = [...onStage]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// The tile menu's Move left / Move right: swap with the neighbouring position.
export function moveCell(onStage: string[], id: string, dir: -1 | 1): string[] {
  const i = onStage.indexOf(id)
  return i === -1 ? onStage : swapCells(onStage, i, i + dir)
}

// Puts newId where oldId was (a take-over replaces the read-only view in
// place). If newId is already on stage, oldId just leaves.
export function replaceOnStage(onStage: string[], oldId: string, newId: string): string[] {
  if (!onStage.includes(oldId)) return onStage
  if (onStage.includes(newId)) return onStage.filter((id) => id !== oldId)
  return onStage.map((id) => (id === oldId ? newId : id))
}

export const toggleMaximize = (maximized: string | null, id: string): string | null => (maximized === id ? null : id)

// A maximized tile that left the stage maximizes nothing.
export function effectiveMaximized(onStage: string[], maximized: string | null): string | null {
  return maximized && onStage.includes(maximized) ? maximized : null
}

// ---- What may be on the stage ---------------------------------------------------
// Desktop sessions go by their desktop id; a read-only view of a session
// running in another terminal goes by outsideKey(its Claude session id).

const OUTSIDE_PREFIX = 'outside:'
export const outsideKey = (sessionId: string): string => `${OUTSIDE_PREFIX}${sessionId}`
export const outsideSessionIdOf = (key: string): string | null => (key.startsWith(OUTSIDE_PREFIX) ? key.slice(OUTSIDE_PREFIX.length) : null)

// The ids the stage may hold, in fill order: desktop sessions not popped out
// to their own window (dock order), then the read-only views already on stage
// whose session still runs. An outside list that couldn't be read (null)
// keeps those views: not knowing isn't "it stopped". Outside views are never
// fillers; only a click puts one on stage.
export function stageCandidates(sessions: DesktopSession[], onStage: string[], outside: OutsideSession[] | null): string[] {
  const running = outside ? new Set(outside.map((o) => o.sessionId)) : null
  const views = onStage.filter((id) => {
    const sid = outsideSessionIdOf(id)
    return sid !== null && (running === null || running.has(sid))
  })
  return [...dockOrder(sessions.filter((s) => !s.poppedOut)), ...views]
}

// ---- Persistence --------------------------------------------------------------

export interface StageState {
  layout: PresetKey
  // Tile positions in the preset's cell order. A session keeps its position
  // until it is displaced, so picking never reshuffles the stage.
  onStage: string[]
  tracks: TrackMap
}

export const STAGE_STORAGE_KEY = 'claude-hub:desktop-stage:v2'
// v1 stored { layout: 'focus' | 'split' | 'grid', onStage }; read once so an
// upgrade keeps the stage it had.
export const LEGACY_STAGE_KEY = 'claude-hub:desktop-layout:v1'
const LEGACY_LAYOUT: Record<string, PresetKey> = { focus: 'focus', split: 'split', grid: 'grid4' }

function parseFracs(value: unknown, n: number): number[] | null {
  if (!Array.isArray(value) || value.length !== n) return null
  if (!value.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) return null
  const sum = (value as number[]).reduce((a, b) => a + b, 0)
  return (value as number[]).map((f) => f / sum)
}

function parseTracks(value: unknown): TrackMap {
  if (!value || typeof value !== 'object') return {}
  const out: TrackMap = {}
  for (const p of PRESETS) {
    const t = (value as Record<string, unknown>)[p.key] as Partial<Tracks> | undefined
    if (!t || typeof t !== 'object') continue
    const cols = parseFracs(t.cols, p.cols)
    const rows = parseFracs(t.rows, p.rows)
    if (cols && rows) out[p.key] = { cols, rows }
  }
  return out
}

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [])

export function parseStageState(raw: string | null, legacyRaw: string | null = null): StageState {
  const fallback: StageState = { layout: 'grid4', onStage: [], tracks: {} }
  const parse = (text: string | null): Record<string, unknown> | null => {
    if (!text) return null
    try {
      const v: unknown = JSON.parse(text)
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const v2 = parse(raw)
  if (v2) {
    const layout = isPresetKey(v2.layout) ? v2.layout : fallback.layout
    return { layout, onStage: ids(v2.onStage).slice(0, capacityOf(layout)), tracks: parseTracks(v2.tracks) }
  }
  const v1 = parse(legacyRaw)
  if (v1) {
    const layout = typeof v1.layout === 'string' ? (LEGACY_LAYOUT[v1.layout] ?? fallback.layout) : fallback.layout
    return { layout, onStage: ids(v1.onStage).slice(0, capacityOf(layout)), tracks: {} }
  }
  return fallback
}
