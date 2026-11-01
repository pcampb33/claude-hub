// Pure logic behind the Config view: target params, layer overrides, the
// audit summary, the neighbour editor's rules and the guard buttons. No
// React, no hubApi, so `node --test` covers it directly.
import type {
  BoundaryAccess,
  BoundaryAudit,
  BoundaryCrossing,
  BoundaryNeighbour,
  BoundaryTier,
  ConfigLayer,
  ConfigLayerScope,
  DesktopTarget,
  DesktopTargetRef,
  GuardStatus,
  LaunchTier,
  ProjectBoundary,
  ProjectConfigReport,
} from '../../../shared/ipc-types.ts'

// ---- targets ----------------------------------------------------------------

// The route param: "#/config/project:<registryId>", "#/config/experiment:<folder>".
export const targetParam = (t: DesktopTargetRef) => `${t.kind}:${t.key}`
export const sameTarget = (a: DesktopTargetRef, b: DesktopTargetRef) => a.kind === b.kind && a.key === b.key

export function parseTargetParam(param: string | null): DesktopTargetRef | null {
  const m = param ? /^(project|experiment):(.+)$/.exec(param) : null
  return m ? { kind: m[1] as DesktopTargetRef['kind'], key: m[2] } : null
}

// Projects first, then sandbox experiments, each alphabetical: a config list
// is scanned by name, not by what ran last.
export function groupTargets(targets: DesktopTarget[], filter: string): { projects: DesktopTarget[]; experiments: DesktopTarget[] } {
  const needle = filter.trim().toLowerCase()
  const shown = targets
    .filter((t) => !needle || t.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return { projects: shown.filter((t) => t.kind === 'project'), experiments: shown.filter((t) => t.kind === 'experiment') }
}

export const TIER_LABEL: Record<BoundaryTier, string> = { audit: 'Audit', guarded: 'Guarded' }

// The chip a boundary shows: claude-hub itself is the admin, whatever tier is saved.
export const chipTier = (b: ProjectBoundary): LaunchTier => (b.admin ? 'admin' : b.tier)

// ---- config layers ------------------------------------------------------------

export const SCOPE_LABEL: Record<ConfigLayerScope, string> = { global: 'Global', project: 'Project', local: 'Local' }
export const SCOPE_NOTE: Record<ConfigLayerScope, string> = {
  global: '~/.claude, every project',
  project: 'checked in with the project',
  local: 'this machine only, not committed',
}

const ORDER: ConfigLayerScope[] = ['global', 'project', 'local']

// The later layer that replaces this layer's single-valued setting, or null
// when nothing later sets it (or this layer doesn't set it either). Lists —
// permission rules, hooks — merge across layers, so only scalars and
// same-named MCP servers can be overridden.
export function overriddenBy(
  layers: ConfigLayer[],
  scope: ConfigLayerScope,
  field: 'model' | 'defaultMode',
): ConfigLayerScope | null {
  const value = (l: ConfigLayer) => (field === 'model' ? l.model : (l.permissions?.defaultMode ?? null))
  const self = layers.find((l) => l.scope === scope)
  if (!self || value(self) === null) return null
  const later = layers
    .filter((l) => ORDER.indexOf(l.scope) > ORDER.indexOf(scope) && value(l) !== null)
    .sort((a, b) => ORDER.indexOf(b.scope) - ORDER.indexOf(a.scope))
  return later[0]?.scope ?? null
}

export function serverOverriddenBy(layers: ConfigLayer[], scope: ConfigLayerScope, name: string): ConfigLayerScope | null {
  const later = layers
    .filter((l) => ORDER.indexOf(l.scope) > ORDER.indexOf(scope) && l.mcpServers.some((s) => s.name === name))
    .sort((a, b) => ORDER.indexOf(b.scope) - ORDER.indexOf(a.scope))
  return later[0]?.scope ?? null
}

// Nothing to say about a layer: no file present and no setting from anywhere.
export function layerIsEmpty(l: ConfigLayer): boolean {
  return (
    l.files.every((f) => !f.exists && !f.error) &&
    l.claudeMdTokens === null &&
    l.model === null &&
    l.permissions === null &&
    l.hooks.length + l.mcpServers.length + l.skills.length + l.agents.length + l.commands.length + l.workflows.length === 0
  )
}

export const compactTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

// Findings that need a look come first; the backend's order holds within a severity.
export const sortFindings = <T extends { severity: 'warn' | 'info' }>(findings: T[]): T[] =>
  [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1))

// The exact file the guard buttons touch. The config report carries the
// local layer's real paths; without it, name the file by folder instead.
export function settingsLocalPath(report: ProjectConfigReport | null, targetName: string): string {
  const local = report?.layers.find((l) => l.scope === 'local')
  const file = local?.files.find((f) => /settings\.local\.json$/i.test(f.path))
  return file ? file.path : `${targetName}\\.claude\\settings.local.json`
}

// ---- neighbours -------------------------------------------------------------

// Why a target can't be added as a neighbour, or null when it can.
export function neighbourProblem(self: DesktopTargetRef, existing: BoundaryNeighbour[], candidate: DesktopTargetRef): string | null {
  if (sameTarget(self, candidate)) return "A project can't be its own neighbour"
  if (existing.some((n) => sameTarget(n.target, candidate))) return 'Already listed'
  return null
}

export function addNeighbour(
  self: DesktopTargetRef,
  existing: BoundaryNeighbour[],
  candidate: DesktopTargetRef,
  access: BoundaryAccess = 'read',
): BoundaryNeighbour[] {
  return neighbourProblem(self, existing, candidate) ? existing : [...existing, { target: candidate, access }]
}

export function sameNeighbours(a: BoundaryNeighbour[], b: BoundaryNeighbour[]): boolean {
  const key = (n: BoundaryNeighbour) => `${targetParam(n.target)}=${n.access}`
  const ka = a.map(key).sort()
  const kb = b.map(key).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i])
}

// ---- guard ------------------------------------------------------------------

export interface GuardButton {
  label: string
  enabled: boolean
  reason: string | null // why it's disabled
}

// The local-settings buttons. Writing needs the SAVED tier to be guarded with
// nothing unsaved (the main process writes the saved boundary). Removing is
// always allowed while hub rules are there, so switching to Audit can undo them.
export function guardButtons(
  savedTier: BoundaryTier,
  guard: GuardStatus,
  dirty: boolean,
  busy: boolean,
): { write: GuardButton | null; remove: GuardButton | null } {
  if (guard.localSettings === 'unreadable') {
    const reason = "settings.local.json couldn't be read; fix or remove it by hand first"
    return {
      write: { label: 'Write guard to settings.local.json', enabled: false, reason },
      remove: { label: 'Remove hub rules', enabled: false, reason },
    }
  }
  const writeReason = busy ? 'Working…' : savedTier !== 'guarded' ? 'Only a guarded project gets deny rules' : dirty ? 'Save the boundary first' : null
  const write: GuardButton | null =
    guard.localSettings === 'current'
      ? null
      : {
          label: guard.localSettings === 'stale' ? 'Refresh guard' : 'Write guard to settings.local.json',
          enabled: writeReason === null,
          reason: writeReason,
        }
  // Unrecorded: writing still works (rules already there stay the user's), but
  // the hub can't tell which rules are its own, so it removes none.
  const remove: GuardButton | null =
    guard.localSettings === 'absent'
      ? null
      : guard.localSettings === 'unrecorded'
        ? { label: 'Remove hub rules', enabled: false, reason: 'The hub has no record of which rules it wrote; remove them from settings.local.json by hand' }
        : { label: 'Remove hub rules', enabled: !busy, reason: busy ? 'Working…' : null }
  return { write, remove }
}

export const LOCAL_SETTINGS_TEXT: Record<GuardStatus['localSettings'], string> = {
  absent: "No hub rules in settings.local.json, so sessions started in other terminals aren't guarded.",
  current: 'settings.local.json carries the current hub rules, so sessions started in other terminals get them too.',
  stale: 'settings.local.json carries an older version of the hub rules; refresh it to match this boundary.',
  unreadable: "settings.local.json couldn't be read, so whether it carries hub rules is unknown.",
  unrecorded:
    "settings.local.json has deny rules like the ones the hub writes, but the hub has no record of writing any here, so it treats them as yours. If boundaries.json was reset, some may be old hub rules; either way they apply to every session here.",
}

// ---- audit --------------------------------------------------------------------

export interface CrossingGroup {
  into: string
  count: number
  mix: Record<BoundaryCrossing['access'], number>
  crossings: BoundaryCrossing[] // newest first
}

export function groupCrossings(crossings: BoundaryCrossing[]): CrossingGroup[] {
  const groups = new Map<string, CrossingGroup>()
  for (const c of crossings) {
    let g = groups.get(c.into)
    if (!g) {
      g = { into: c.into, count: 0, mix: { read: 0, write: 0, shell: 0 }, crossings: [] }
      groups.set(c.into, g)
    }
    g.count++
    g.mix[c.access]++
    g.crossings.push(c)
  }
  for (const g of groups.values()) g.crossings.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return [...groups.values()].sort((a, b) => b.count - a.count || a.into.localeCompare(b.into))
}

// "(shell)" when one kind, else "(12 shell, 7 read)", biggest first.
export function mixText(mix: CrossingGroup['mix']): string {
  const parts = (Object.entries(mix) as [string, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  return parts.length === 1 ? `(${parts[0][0]})` : `(${parts.map(([k, n]) => `${n} ${k}`).join(', ')})`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// One line over the audit, e.g. "23 crossings in 11 sessions — 19 into
// trading-bot-v2 (shell), 4 into vault (read)". null when there are none.
export function auditSummary(audit: BoundaryAudit): string | null {
  if (audit.total === 0) return null
  const sessions = new Set(audit.crossings.map((c) => c.sessionId)).size
  const capped = audit.total > audit.crossings.length
  const head = `${plural(audit.total, 'crossing')} in ${capped ? 'at least ' : ''}${plural(sessions, 'session')}`
  const groups = groupCrossings(audit.crossings)
  const shown = groups.slice(0, 3).map((g) => `${g.count} into ${g.into} ${mixText(g.mix)}`)
  const more = groups.length > 3 ? `, and ${groups.length - 3} more` : ''
  return `${head} — ${shown.join(', ')}${more}${capped ? ` (newest ${audit.crossings.length} listed)` : ''}`
}

// The zero state only claims "no crossings" when sessions were actually read,
// and never "no sessions" when the audit failed or the transcripts were unreadable.
export function auditEmptyText(audit: BoundaryAudit, days: number): string {
  if (audit.error) return audit.sessionsScanned > 0 ? `No crossings in the sessions that could be read` : `Couldn't audit the last ${days} days`
  if (audit.sessionsScanned > 0) return `No crossings in the last ${days} days`
  return audit.sessionsUnreadable > 0 ? `No readable sessions in the last ${days} days` : `No sessions in the last ${days} days`
}

export function unreadableNote(audit: BoundaryAudit): string | null {
  const n = audit.sessionsUnreadable
  return n > 0 ? `${plural(n, 'transcript')} couldn't be read; the audit may be incomplete.` : null
}

// Refused calls aren't crossings (they never ran); they show the guard held.
export function blockedNote(audit: BoundaryAudit): string | null {
  const n = audit.blocked
  return n > 0 ? `${plural(n, 'attempt')} outside the boundary ${n === 1 ? 'was' : 'were'} refused (a deny rule, the classifier or you at the prompt) and didn't run.` : null
}
