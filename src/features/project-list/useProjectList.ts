import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAllProjectsStatus, type ProjectWithStatus } from '../shared/useAllProjectsStatus'
import { useAllProjectsConfigHealth } from '../shared/useAllProjectsConfigHealth'
import type { LatestSessionEntry } from '../../../shared/ipc-types'

export type { ProjectWithStatus }

export type SortKey = 'name' | 'git' | 'activity' | 'health'
export type SortDir = 'asc' | 'desc'

// Natural default direction when a key is first selected. Name reads best A→Z;
// Git already ranks most-urgent-highest and Activity most-recent-highest, so
// both lead with desc; Health leads with asc so the lowest (worst) score comes
// first — a triage list wants what needs attention up top, not the healthiest.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  git: 'desc',
  activity: 'desc',
  health: 'asc',
}

// Enriched master-row entry: the base status plus the two extra per-project
// signals the master list now surfaces (latest session + config-health score).
// Extends ProjectWithStatus so it stays assignable wherever a plain status
// entry is expected (e.g. ProjectDetail's `project` prop).
export interface ProjectListEntry extends ProjectWithStatus {
  configHealthScore: number | null // null = no project CLAUDE.md to score
  latestSession: LatestSessionEntry | null
}

// Mirrors the dashboard's STALE_DAYS cutoff (useDashboard.ts) — not imported
// because that module isn't exported feature-to-feature and 14 days is the
// one shared constant, not shared logic.
const STALE_MS = 14 * 24 * 60 * 60 * 1000

// "Ran, then went quiet for a fortnight" is staleness. "Never ran at all" is
// not — it is a project that has yet to start, and calling it stale made this
// view claim there had been recent activity to lose. Mirrors isStale/hasEverRun
// in dashboard/useDashboard.ts, which owns the same distinction for the KPI
// tile that deep-links here; the two must agree or the tile says 1 and the list
// it opens shows 8. The 14-day constant stays duplicated rather than imported,
// per the note on STALE_MS above.
function isStale(p: ProjectListEntry): boolean {
  const last = p.status?.lastActivity
  if (p.status?.pathExists !== true || !last) return false
  return Date.now() - new Date(last).getTime() > STALE_MS
}

// Triage bucket for the master column's scope toggle and row ticks.
// danger = the project itself is broken (missing path, failing health);
// warn = it merely wants a look (dirty tree, or stale: ran, then no session
// activity in 14 days). null = nothing needs attention.
export function attentionKind(p: ProjectListEntry): 'danger' | 'warn' | null {
  if (p.status && !p.status.pathExists) return 'danger'
  if (p.configHealthScore !== null && p.configHealthScore < 60) return 'danger'
  if (p.status?.git?.dirty === true) return 'warn'
  if (isStale(p)) return 'warn'
  return null
}

// The baseline the Needs-attention feed already scores against, and the one
// the Dashboard's health tile now names in its verdict line.
const HEALTH_BASELINE = 80

// Scopes the master column can be narrowed to. Everything but 'all' is also a
// route word: the Dashboard's KPI tiles deep-link as `#/projects/<scope>` so
// three different diagnoses stop landing on one undifferentiated list. The
// contract is documented above the SCOPE_* consts in dashboard/KpiStrip.tsx;
// registry ids are UUIDs, so a bare word can never be mistaken for one.
//
// There is no 'floors' scope on purpose: ProjectListEntry carries no floor
// data (it is fetched per project, on demand, by ProjectDetail), so this view
// cannot honestly filter by it. A tile that deep-linked here for floors would
// silently land on every project while implying a filter had been applied.
export type ProjectScope = 'all' | 'attention' | 'dirty' | 'stale' | 'health'

export const SCOPE_LABELS: Record<Exclude<ProjectScope, 'all'>, string> = {
  attention: 'Needs attention',
  dirty: 'Uncommitted',
  stale: 'Stale · 14d+',
  health: `Below ${HEALTH_BASELINE}`,
}

export function isProjectScope(value: string): value is ProjectScope {
  return value === 'all' || value in SCOPE_LABELS
}

export function matchesScope(p: ProjectListEntry, scope: ProjectScope): boolean {
  switch (scope) {
    case 'all':
      return true
    case 'attention':
      return attentionKind(p) !== null
    case 'dirty':
      return p.status?.git?.dirty === true
    case 'stale':
      return isStale(p)
    case 'health':
      return p.configHealthScore !== null && p.configHealthScore < HEALTH_BASELINE
  }
}

// Higher = more urgent, so descending surfaces the projects that want
// attention: missing paths, then dirty, then clean, then non-repos. Ported
// from the deleted dashboard ProjectTable so this view no longer depends on it.
function gitRank(entry: ProjectListEntry): number {
  if (!entry.status?.pathExists) return 3
  const dirty = entry.status?.git?.dirty ?? null
  return dirty === true ? 2 : dirty === false ? 1 : 0
}

// Compare two entries on the active key, returning the ascending ordering; the
// caller negates for descending. `null` values (never-active, unscored) always
// sort last regardless of direction, so flipping never dredges up empty rows.
function compareEntries(a: ProjectListEntry, b: ProjectListEntry, key: SortKey, dir: SortDir): number {
  const nullsLast = (an: boolean, bn: boolean) => (an ? (bn ? 0 : 1) : bn ? -1 : 0)
  let cmp: number
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name)
      break
    case 'git':
      cmp = gitRank(a) - gitRank(b)
      break
    case 'activity': {
      const al = a.status?.lastActivity ?? null
      const bl = b.status?.lastActivity ?? null
      if (!al || !bl) return nullsLast(!al, !bl)
      cmp = new Date(al).getTime() - new Date(bl).getTime()
      break
    }
    case 'health': {
      if (a.configHealthScore === null || b.configHealthScore === null)
        return nullsLast(a.configHealthScore === null, b.configHealthScore === null)
      cmp = a.configHealthScore - b.configHealthScore
      break
    }
  }
  return dir === 'asc' ? cmp : -cmp
}

export function useProjectList() {
  const { entries, loading, error, refresh: refreshStatus } = useAllProjectsStatus()
  const { entries: healthEntries, refresh: refreshHealth } = useAllProjectsConfigHealth()

  // Latest-session titles come from a single all-projects IPC call (mirrors
  // useDashboard's refreshExtras, minus the batched inbox/activity fetches this
  // view doesn't need). Enriches rows in place — never gates `loading`, which
  // stays tied to the primary status fetch so the list paints as soon as it can.
  const [latestSessions, setLatestSessions] = useState<LatestSessionEntry[] | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const latestCall = useRef(0)

  const refreshSessions = useCallback(async () => {
    const callId = ++latestCall.current
    try {
      const sessions = await window.hubApi.latestSessionPerProject()
      // A newer refresh started while this one was in flight — let its result win.
      if (callId !== latestCall.current) return
      setLatestSessions(sessions)
      setSessionsError(null)
    } catch (err) {
      // Rejecting here used to be an unhandled rejection that blanked the
      // latest-session column with no explanation. It rides the view's existing
      // ErrorNotice rather than getting a surface of its own.
      if (callId !== latestCall.current) return
      setSessionsError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  const [sortKey, setSortKey] = useState<SortKey>('activity')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Same-key click flips direction; a new key adopts its natural default
  // (see DEFAULT_DIR — each key leads with its most-useful-first ordering).
  const toggleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir(DEFAULT_DIR[key])
      }
    },
    [sortKey],
  )

  const refresh = useCallback(() => {
    refreshStatus()
    refreshHealth()
    refreshSessions()
  }, [refreshStatus, refreshHealth, refreshSessions])

  const projects = useMemo((): ProjectListEntry[] => {
    const healthByPath = new Map(healthEntries.map((e) => [e.path, e.configHealth]))
    const sessionById = new Map((latestSessions ?? []).map((s) => [s.registryId, s]))
    const enriched: ProjectListEntry[] = entries.map((entry) => {
      const health = healthByPath.get(entry.path)
      return {
        ...entry,
        // Match the dashboard: an absent project CLAUDE.md is unscored (null),
        // not a real zero — so it sorts to the bottom rather than reading worst.
        configHealthScore: health?.project.exists ? health.score : null,
        latestSession: sessionById.get(entry.id) ?? null,
      }
    })
    // Pinned always floats to the top (its whole point); the active sort orders
    // everything below it.
    return enriched.sort((a, b) => {
      const pinDelta = Number(b.pinned ?? false) - Number(a.pinned ?? false)
      if (pinDelta !== 0) return pinDelta
      return compareEntries(a, b, sortKey, sortDir)
    })
  }, [entries, healthEntries, latestSessions, sortKey, sortDir])

  return { projects, loading, error: error ?? sessionsError, refresh, sortKey, sortDir, toggleSort }
}
