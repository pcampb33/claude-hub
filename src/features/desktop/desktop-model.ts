// Session Desktop: pure logic behind the dock, the stage and the terminal
// feed. No React, no DOM, no hubApi, so `node --test` covers it directly.
import {
  DESKTOP_COLORS,
  type DesktopColor,
  type DesktopSession,
  type DesktopSessionState,
  type DesktopSnapshot,
  type DesktopTerminalChunk,
} from '../../../shared/ipc-types.ts'

// What the desk body shows. Unreadable records are an error, never the
// "Start a session" empty state: nothing could be listed, and create would
// be refused.
export function deskBody(snapshot: DesktopSnapshot): 'records-error' | 'empty' | 'sessions' {
  if (snapshot.records.error) return 'records-error'
  return snapshot.sessions.length === 0 ? 'empty' : 'sessions'
}

// IPC rejections arrive as "Error invoking remote method '<channel>': Error:
// <message>"; the message is the part worth showing.
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ---- Dock -----------------------------------------------------------------

export type DockGroupKey = 'needs-you' | 'working' | 'your-turn' | 'other'

export interface DockGroup {
  key: DockGroupKey
  label: string
  sessions: DesktopSession[]
}

const GROUP_LABEL: Record<DockGroupKey, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  'your-turn': 'Your turn',
  other: 'Other',
}

export function groupOf(state: DesktopSessionState): DockGroupKey {
  if (state === 'needs-you' || state === 'working' || state === 'your-turn') return state
  return 'other'
}

// Starting/unknown are live and ahead of exited inside Other.
const OTHER_RANK: Partial<Record<DesktopSessionState, number>> = { starting: 0, unknown: 1, exited: 2 }

// Groups in attention order, empty groups dropped. Inside a group cards keep
// slot order, so a card only moves when its state does.
export function groupDock(sessions: DesktopSession[]): DockGroup[] {
  const groups: DockGroup[] = (['needs-you', 'working', 'your-turn', 'other'] as const).map((key) => ({
    key,
    label: GROUP_LABEL[key],
    sessions: [],
  }))
  for (const s of sessions) groups.find((g) => g.key === groupOf(s.state))!.sessions.push(s)
  for (const g of groups) {
    g.sessions.sort((a, b) => (OTHER_RANK[a.state] ?? 0) - (OTHER_RANK[b.state] ?? 0) || a.slot - b.slot)
  }
  return groups.filter((g) => g.sessions.length > 0)
}

// The dock in display order, flattened: what the stage fills empty tiles from.
export function dockOrder(sessions: DesktopSession[]): string[] {
  return groupDock(sessions).flatMap((g) => g.sessions.map((s) => s.id))
}

export interface DockSummary {
  total: number
  needsYou: number
  working: number
}

export function summarize(sessions: DesktopSession[]): DockSummary {
  return {
    total: sessions.length,
    needsYou: sessions.filter((s) => s.state === 'needs-you').length,
    working: sessions.filter((s) => s.state === 'working').length,
  }
}

export const STATE_LABEL: Record<DesktopSessionState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  'your-turn': 'Your turn',
  starting: 'Starting',
  unknown: 'State unknown',
  exited: 'Exited',
}

// Compact duration: 45s → "<1m", 42m, 1h 05m, 5h, 2d.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return hours < 3 && rest > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

// The time shown on a card: how long it has been idle when the turn is yours
// or the process ended, otherwise how long the session has existed.
export function sessionTime(s: DesktopSession, nowMs: number): string {
  if (s.state === 'your-turn' || s.state === 'exited') {
    if (!s.lastActivityIso) return s.state === 'exited' ? 'ended' : 'idle'
    const since = formatDuration(nowMs - Date.parse(s.lastActivityIso))
    return s.state === 'exited' ? `ended ${since} ago` : `idle ${since}`
  }
  return formatDuration(nowMs - Date.parse(s.createdAtIso))
}

// The identity colour as the `--c` custom property every card, tile and
// swatch paints from (desktop.css defines --desk-id-* per theme).
export const idColor = (color: DesktopColor) => ({ '--c': `var(--desk-id-${color})` }) as Record<string, string>

// ---- New session defaults --------------------------------------------------

export function defaultName(projectName: string, sessions: DesktopSession[]): string {
  const taken = new Set(sessions.map((s) => s.name))
  if (!taken.has(projectName)) return projectName
  for (let n = 2; ; n++) {
    const candidate = `${projectName} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// First colour no live session wears; with all six in use, the least worn
// (ties to palette order).
export function defaultColor(sessions: DesktopSession[]): DesktopColor {
  const uses = new Map<DesktopColor, number>(DESKTOP_COLORS.map((c) => [c, 0]))
  for (const s of sessions) if (s.alive) uses.set(s.color, (uses.get(s.color) ?? 0) + 1)
  let best: DesktopColor = DESKTOP_COLORS[0]
  for (const c of DESKTOP_COLORS) if (uses.get(c)! < uses.get(best)!) best = c
  return best
}

// ---- Stage -----------------------------------------------------------------

// Presets, tracks and persistence live in layout-model.ts; these keep which
// sessions hold the tile positions, for any capacity.

// Rank in the most-recently-picked list; never-picked sessions rank last.
function recency(mru: string[], id: string): number {
  const i = mru.indexOf(id)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

// Picking a session already on stage changes nothing here (focus moves, the
// tiles stay). Otherwise it takes a free position, or displaces the least
// recently picked tile in place.
export function pickOnStage(onStage: string[], capacity: number, id: string, mru: string[]): string[] {
  if (onStage.includes(id)) return onStage
  if (onStage.length < capacity) return [...onStage, id]
  let victim = 0
  for (let i = 1; i < onStage.length; i++) {
    if (recency(mru, onStage[i]) > recency(mru, onStage[victim])) victim = i
  }
  return onStage.map((x, i) => (i === victim ? id : x))
}

// Shrinking the layout keeps the most recently picked tiles, in their
// positional order.
export function shrinkStage(onStage: string[], capacity: number, mru: string[]): string[] {
  if (onStage.length <= capacity) return onStage
  const keep = new Set([...onStage].sort((a, b) => recency(mru, a) - recency(mru, b)).slice(0, capacity))
  return onStage.filter((id) => keep.has(id))
}

// Drops tiles whose session is gone (forgotten), then fills free positions:
// most recently picked first, then dock order. A gone tile is replaced in its
// own position when there is a filler for it.
export function reconcileStage(onStage: string[], capacity: number, existing: string[], mru: string[]): string[] {
  const present = new Set(existing)
  const used = new Set(onStage.filter((id) => present.has(id)))
  const fillers = [...mru.filter((id) => present.has(id)), ...existing].filter(
    (id, i, all) => !used.has(id) && all.indexOf(id) === i,
  )
  const next: string[] = []
  for (const id of onStage.slice(0, capacity)) {
    if (present.has(id)) next.push(id)
    else if (fillers.length > 0) next.push(fillers.shift()!)
  }
  while (next.length < capacity && fillers.length > 0) next.push(fillers.shift()!)
  return next
}

// ---- Terminal feed -----------------------------------------------------------

// Orders a session's output around the screen seed so nothing is lost or
// written twice. Subscribe first and push() every chunk; chunks are held until
// seed() is called with the fetched screen's seq, which releases the held ones
// that are newer than the screen. After that, push() passes through anything
// newer than the last chunk written. Each call returns the data to write now.
export class ChunkSequencer {
  private held: DesktopTerminalChunk[] | null = []
  private last = -Infinity

  push(chunk: DesktopTerminalChunk): string[] {
    if (this.held) {
      this.held.push(chunk)
      return []
    }
    if (chunk.seq <= this.last) return []
    this.last = chunk.seq
    return [chunk.data]
  }

  // screenSeq = the seq the written screen already includes; -Infinity when
  // there is no screen (the fetch failed) and every held chunk should go out.
  seed(screenSeq: number): string[] {
    const held = this.held ?? []
    this.held = null
    this.last = screenSeq
    const out: string[] = []
    for (const chunk of [...held].sort((a, b) => a.seq - b.seq)) {
      if (chunk.seq <= this.last) continue
      this.last = chunk.seq
      out.push(chunk.data)
    }
    return out
  }
}
