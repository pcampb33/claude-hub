// The session launcher's rows: what each one is, how it's found by the search
// box, and what Enter does on it. Pure, so `node --test` covers it directly.
import type {
  DesktopColor,
  DesktopLaunchSpec,
  DesktopLaunchTargets,
  DesktopSession,
  DesktopTargetRef,
  OutsideSession,
} from '../../../shared/ipc-types.ts'
import { defaultName } from './desktop-model.ts'

// "(no message found)" and its kin are placeholders, not names: one copied
// into --name becomes the conversation's real title in Claude Code.
const isPlaceholderTitle = (title: string) => /^\(.*\)$/.test(title.trim()) || title.trim() === 'Untitled conversation'

export type LaunchAction =
  | { kind: 'take-over'; pid: number; sessionId: string }
  | { kind: 'resume'; target: DesktopTargetRef; sessionId: string }
  | { kind: 'new'; target: DesktopTargetRef }
  | { kind: 'unavailable'; reason: string }

// The launcher's three tabs, and the three groups a search returns.
export type GroupKey = 'continue' | 'new' | 'takeover'

export interface LauncherRow {
  key: string // unique across groups
  group: GroupKey
  name: string
  where: string
  status: string | null // take-over rows: Claude Code's own status word
  recencyIso: string | null
  baseName: string // the session name it suggests, before de-duplication
  action: LaunchAction
  older: LauncherRow[] // a Continue row's earlier conversations in the same place, newest first
}

export type LauncherModel = Record<GroupKey, LauncherRow[]>

export interface LauncherGroup {
  key: GroupKey
  label: string
  rows: LauncherRow[] // what's shown: capped unless "show all"
  total: number // before the cap
}

export const GROUP_ORDER: GroupKey[] = ['continue', 'new', 'takeover']
export const GROUP_LABEL: Record<GroupKey, string> = { continue: 'Continue', new: 'New', takeover: 'Take over' }
export const TAB_CAP = 8
export const SEARCH_CAP = 5

export const OUTSIDE_STATUS: Record<OutsideSession['status'], string> = {
  idle: 'Idle',
  busy: 'Working',
  // Claude Code keeps 'shell' while a background process it started runs,
  // turn over or not, so this can't claim it's working.
  shell: 'Background process',
  waiting: 'Needs you',
  unknown: 'Status unknown',
}

// A conversation title as a session name: whitespace collapsed, at most `max`
// characters with an ellipsis when cut.
export function trimTitle(title: string, max = 40): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

const folderName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

// How an outside session is named everywhere (launcher, dock, stage): its
// Claude Code name, else where it runs.
export function outsideLabel(o: OutsideSession): { name: string; where: string } {
  const where = o.targetName ?? folderName(o.cwd)
  return { name: o.name.trim() || where, where }
}

export function outsideRow(o: OutsideSession): LauncherRow {
  const { name, where } = outsideLabel(o)
  return {
    key: `outside:${o.sessionId}`,
    group: 'takeover',
    name,
    where,
    status: OUTSIDE_STATUS[o.status],
    recencyIso: o.updatedAtIso,
    baseName: name,
    // A desktop session needs a project or experiment to run in; main
    // resolves the folder from that, never from a raw path.
    action: o.target
      ? { kind: 'take-over', pid: o.pid, sessionId: o.sessionId }
      : { kind: 'unavailable', reason: "Its folder isn't a registered project or sandbox experiment, so the desktop can't run it." },
    older: [],
  }
}

const byRecency = (a: string | null, b: string | null): number => {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? 1 : -1
}

export interface LauncherInput {
  outside: OutsideSession[] | null // the snapshot's; null = couldn't be read
  launch: DesktopLaunchTargets | null // null = loading or failed
  sessions: DesktopSession[] // on the desktop already
}

// Every row the launcher can show, by group. Conversations already on the
// desktop aren't offered again, and one that runs in another terminal is
// offered once, as a take-over. Continue has one row per place (its latest
// conversation), places ordered by that conversation's recency.
export function buildModel({ outside, launch, sessions }: LauncherInput): LauncherModel {
  const onDesktop = new Set(sessions.map((s) => s.claudeSessionId))
  const running = new Set((outside ?? []).map((o) => o.sessionId))

  const takeover = [...(outside ?? [])].sort((a, b) => byRecency(a.updatedAtIso, b.updatedAtIso)).map(outsideRow)

  const byPlace = new Map<string, LauncherRow[]>()
  for (const r of [...(launch?.recent ?? [])].sort((a, b) => byRecency(a.lastActivityIso, b.lastActivityIso))) {
    if (onDesktop.has(r.sessionId) || running.has(r.sessionId)) continue
    const place = `${r.target.kind}:${r.target.key}`
    const list = byPlace.get(place) ?? []
    list.push({
      key: `recent:${r.sessionId}`,
      group: 'continue',
      name: r.title.trim() || '(untitled conversation)',
      where: r.targetName,
      status: null,
      recencyIso: r.lastActivityIso,
      baseName: isPlaceholderTitle(r.title) ? r.targetName : trimTitle(r.title) || r.targetName,
      action: r.liveElsewhere
        ? { kind: 'unavailable', reason: "It's running in another terminal, but that process wasn't found to take it over." }
        : { kind: 'resume', target: r.target, sessionId: r.sessionId },
      older: [],
    })
    byPlace.set(place, list)
  }
  const continueRows = [...byPlace.values()].map(([latest, ...older]) => ({ ...latest, older }))

  // Projects and experiments together: most recent activity first, never-used last by name.
  const newRows: LauncherRow[] = [...(launch?.targets ?? [])]
    .sort((a, b) => byRecency(a.lastActivityIso, b.lastActivityIso) || a.name.localeCompare(b.name))
    .map((t) => ({
      key: `${t.kind}:${t.key}`,
      group: 'new',
      name: t.name,
      where: t.kind,
      status: null,
      recencyIso: t.lastActivityIso,
      baseName: t.name,
      action: { kind: 'new', target: { kind: t.kind, key: t.key } },
      older: [],
    }))

  return { continue: continueRows, new: newRows, takeover }
}

// An empty Continue or New tab. When part of the list couldn't be read, the
// emptiness may be that failure, so it doesn't claim there is nothing.
export function emptyNote(key: GroupKey, error: string | null): string {
  if (error) return "Nothing listed here, but part of the list couldn't be read (see above), so there may be more."
  return key === 'continue'
    ? 'No earlier conversations to continue. Start one from New.'
    : 'No projects or sandbox experiments yet. Add a project in Projects to start a session in it.'
}

// Take over is a tab only while something runs in another terminal.
export const visibleTabs = (model: LauncherModel): GroupKey[] => (model.takeover.length > 0 ? GROUP_ORDER : ['continue', 'new'])

// The tab the launcher shows: the one picked this visit if it still exists;
// else Continue whenever it has rows (or while they load); else the last tab
// used, if it has rows; else the first tab that does.
export function chooseTab(model: LauncherModel, picked: GroupKey | null, stored: string | null, loading: boolean): GroupKey {
  const tabs = visibleTabs(model)
  if (picked && tabs.includes(picked)) return picked
  if (loading || model.continue.length > 0) return 'continue'
  const last = tabs.find((t) => t === stored)
  if (last && model[last].length > 0) return last
  return tabs.find((t) => model[t].length > 0) ?? 'continue'
}

// What the list shows. No query: the tab's rows, the first TAB_CAP unless
// shown all. A query: all three groups searched at once, each ranked and
// capped at SEARCH_CAP; Continue searches every conversation, not just each
// place's latest.
export function launcherView(model: LauncherModel, tab: GroupKey, query: string, showAll: ReadonlySet<GroupKey>): LauncherGroup[] {
  const group = (key: GroupKey, rows: LauncherRow[], cap: number): LauncherGroup => ({
    key,
    label: GROUP_LABEL[key],
    rows: showAll.has(key) ? rows : rows.slice(0, cap),
    total: rows.length,
  })
  if (!query.trim()) return [group(tab, model[tab], TAB_CAP)]
  const conversations = model.continue
    .flatMap(({ older, ...latest }) => [{ ...latest, older: [] }, ...older])
    .sort((a, b) => byRecency(a.recencyIso, b.recencyIso))
  const pools: Record<GroupKey, LauncherRow[]> = { continue: conversations, new: model.new, takeover: model.takeover }
  return GROUP_ORDER.map((key) => group(key, filterRows(pools[key], query), SEARCH_CAP))
}

// The rows ↑/↓ walk, in screen order: an expanded Continue row is followed
// by its older conversations.
export const navRows = (groups: LauncherGroup[], expanded: ReadonlySet<string>): LauncherRow[] =>
  groups.flatMap((g) => g.rows.flatMap((r) => (expanded.has(r.key) ? [r, ...r.older] : [r])))

// Every word of the query must appear in the row's name, place or status.
// Ranked by where the query starts: the name itself, then a word of the
// name, then anywhere; recency order breaks ties (the sort is stable).
export function filterRows(rows: LauncherRow[], query: string): LauncherRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const words = q.split(/\s+/)
  const rank = (row: LauncherRow): number => {
    const name = row.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.split(/[\s\-_./]+/).some((w) => w.startsWith(words[0]))) return 1
    return 2
  }
  return rows
    .filter((row) => {
      const hay = `${row.name} ${row.where} ${row.status ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .map((row) => ({ row, r: rank(row) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.row)
}

// ↑/↓ through every visible row, stopping at the ends. No highlight (or one
// filtered away) starts from the top.
export function moveHighlight(rows: LauncherRow[], current: string | null, dir: -1 | 1): string | null {
  if (rows.length === 0) return null
  const i = rows.findIndex((r) => r.key === current)
  if (i === -1) return rows[0].key
  return rows[Math.min(Math.max(i + dir, 0), rows.length - 1)].key
}

export function autoName(row: LauncherRow, sessions: DesktopSession[]): string {
  return defaultName(row.baseName, sessions)
}

export function actionLabel(action: LaunchAction): string | null {
  switch (action.kind) {
    case 'take-over':
      return 'Take over'
    case 'resume':
      return 'Resume'
    case 'new':
      return 'New session'
    default:
      return null
  }
}

// The createDesktopSession spec for a resume or new row; take-over has its
// own call and unavailable rows have none.
export function launchSpec(action: LaunchAction, name: string, color: DesktopColor): DesktopLaunchSpec | null {
  if (action.kind === 'resume') return { target: action.target, mode: 'resume', sessionId: action.sessionId, name, color }
  if (action.kind === 'new') return { target: action.target, mode: 'new', name, color }
  return null
}
