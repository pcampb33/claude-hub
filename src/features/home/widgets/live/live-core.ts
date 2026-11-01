import type {
  ActivityKind,
  ActivityNow,
  LiveProjectStatus,
  LiveStatusSnapshot,
  SessionActivity,
} from '../../../../../shared/ipc-types'

// Pure helpers for the Live sessions widget and its peek.

// The ribbon's legend groups. Few hues: the short-lived tools (reads, web,
// agents, other) share one and only the kinds that take real time get their
// own. 'waiting' is hatched as well as coloured, so it never depends on hue
// alone.
export type RibbonGroup = 'waiting' | 'thinking' | 'shell' | 'edit' | 'tools' | 'background'
export const RIBBON_LEGEND: { group: RibbonGroup; label: string }[] = [
  { group: 'waiting', label: 'waiting on you' },
  { group: 'thinking', label: 'thinking' },
  { group: 'shell', label: 'shell' },
  { group: 'edit', label: 'edits' },
  { group: 'tools', label: 'other tools' },
  { group: 'background', label: 'background agents' },
]

export function ribbonGroup(kind: ActivityKind): RibbonGroup {
  if (kind === 'read' || kind === 'web' || kind === 'agent' || kind === 'other') return 'tools'
  return kind
}

// "0m", "<1m", "14m", "2.1h" — the ribbon's sentence and tooltips. Some time
// under 30s reads "<1m", not "0m", so a kind that did happen never reads as
// one that didn't.
export function formatSpan(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`
  if (ms > 0 && ms < 30_000) return '<1m'
  return `${Math.round(ms / 60_000)}m`
}

export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const plural =(n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function doing(now: ActivityNow): string {
  if (now.state === 'waiting') return ''
  if (now.state === 'thinking') return now.tool ? `Thinking · last ${now.tool} ${now.target ?? ''}`.trim() : 'Thinking'
  const t = now.target
  switch (now.cat) {
    case 'edit':
      return `Editing ${t}`
    case 'shell':
      return `Running ${t}`
    case 'read':
      return now.tool === 'Read' ? `Reading ${t}` : `Searching ${t}`
    case 'agent':
      return `Agent: ${t}`
    case 'web':
      return `Browsing ${t}`
    default:
      return `${now.tool} ${t}`.trim()
  }
}

// The one line under a live row's ribbon: what it is doing now, the edits so
// far, and how long it has waited on you (dropped while it IS waiting — the
// first clause already says so).
export function activitySentence(a: SessionActivity, clock: (ms: number) => string): string {
  const edits = a.editsCount === 0 ? 'no edits yet' : `${plural(a.editsCount, 'edit', 'edits')} in ${plural(a.filesEdited, 'file', 'files')}`
  if (!a.now) return edits
  if (a.now.state === 'waiting') return [`Turn over — waiting on you since ${clock(a.now.sinceMs)}`, edits].join(' · ')
  return [doing(a.now), edits, `waited on you ${formatSpan(a.waitedMs)}`].join(' · ')
}

// The peek's "where the time went": whole-session totals by legend group,
// largest first, then the breaks the ribbon draws compressed.
export function whereTimeWent(a: SessionActivity): string {
  const byGroup = new Map<RibbonGroup, number>()
  for (const [kind, ms] of Object.entries(a.totals) as [ActivityKind, number][])
    byGroup.set(ribbonGroup(kind), (byGroup.get(ribbonGroup(kind)) ?? 0) + ms)
  const label = new Map(RIBBON_LEGEND.map((l) => [l.group, l.label]))
  const parts = [...byGroup].filter(([, ms]) => ms > 0).sort((x, y) => y[1] - x[1]).map(([g, ms]) => `${label.get(g)} ${formatSpan(ms)}`)
  if (a.breakCount > 0) parts.push(`${plural(a.breakCount, 'break', 'breaks')} over 2h (${formatSpan(a.breakMs)})`)
  return parts.length ? parts.join(' · ') : 'no time recorded yet'
}

// Running sessions only (ended ones belong to the Sessions view), working
// before idle, most recent first.
export function liveSessions(snapshot: LiveStatusSnapshot): LiveProjectStatus[] {
  return snapshot.projects
    .filter((p) => p.state !== 'ended')
    .sort((a, b) => (a.state === b.state ? (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? '') : a.state === 'active' ? -1 : 1))
}

// The peek is scoped by session id; a transcript without one (cannot happen
// for a live session, but the field is optional) falls back to the project.
export const sessionKey = (p: LiveProjectStatus) => p.sessionId ?? p.registryId

export function findSession(snapshot: LiveStatusSnapshot, key: string): LiveProjectStatus | undefined {
  return snapshot.projects.find((p) => p.sessionId === key || p.registryId === key)
}

// How many more turns fit, at the average growth of the last few turns. An
// estimate: one big file read moves it a lot, and compaction resets it.
export const ROOM_WINDOW = 10
export type Room =
  | { kind: 'estimate'; turns: number; perTurn: number }
  | { kind: 'too-few' } // fewer than two turns to measure growth from
  | { kind: 'not-growing' } // flat or shrinking (compaction): no finite estimate
  | { kind: 'unknown' } // no context size or limit reported

export function roomLeft(p: LiveProjectStatus): Room {
  const turns = p.recentTurns ?? []
  if (p.contextLimit === undefined || (p.contextTokens === undefined && turns.length === 0)) return { kind: 'unknown' }
  const recent = turns.slice(-ROOM_WINDOW)
  if (recent.length < 2) return { kind: 'too-few' }
  const perTurn = (recent[recent.length - 1].input - recent[0].input) / (recent.length - 1)
  if (perTurn <= 0) return { kind: 'not-growing' }
  const used = p.contextTokens ?? recent[recent.length - 1].input
  return { kind: 'estimate', turns: Math.max(0, Math.floor((p.contextLimit - used) / perTurn)), perTurn }
}

// "claude-opus-5-5" → "Opus 5.5"; anything else as reported. A synthetic
// "<synthetic>" model is not a model name, so it reads as none.
export function modelLabel(model: string | undefined): string | null {
  if (!model || model.startsWith('<')) return null
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (!m) return model
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export function liveMeta(sessions: LiveProjectStatus[]): string | null {
  if (sessions.length === 0) return null
  const working = sessions.filter((s) => s.state === 'active').length
  const idle = sessions.length - working
  return [working > 0 ? `${working} working` : null, idle > 0 ? `${idle} idle` : null].filter(Boolean).join(' · ')
}
