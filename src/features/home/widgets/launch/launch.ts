import type { RegistryEntry, SkillEntry, SkillUsage, WorkflowEntry } from '../../../../../shared/ipc-types'

const DAY_MS = 24 * 60 * 60_000
export const WINDOW_DAYS = 30

export interface SkillStat {
  name: string
  uses30: number
  usesAll: number
  lastUsed: string | null
  // Where it ran, all time, busiest first.
  projects: { name: string; count: number }[]
  // Registry id of the most recent invocation in a registered project — the
  // natural default for "start a session with this".
  recentProjectId: string | null
}

export function skillStat(u: SkillUsage, now: number): SkillStat {
  const since = now - WINDOW_DAYS * DAY_MS
  const byProject = new Map<string, number>()
  let uses30 = 0
  for (const inv of u.invocations) {
    if (new Date(inv.ts).getTime() >= since) uses30++
    byProject.set(inv.project, (byProject.get(inv.project) ?? 0) + 1)
  }
  return {
    name: u.skill,
    uses30,
    usesAll: u.count,
    lastUsed: u.lastUsed || null,
    projects: [...byProject].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    recentProjectId: u.invocations.find((i) => i.projectId)?.projectId ?? null,
  }
}

// Skills used in the last 30 days, busiest first.
export function topSkills(usage: SkillUsage[], now: number): SkillStat[] {
  return usage
    .map((u) => skillStat(u, now))
    .filter((s) => s.uses30 > 0)
    .sort((a, b) => b.uses30 - a.uses30 || b.usesAll - a.usesAll || a.name.localeCompare(b.name))
}

// No run counts exist for workflows, so the launch pad shows the most
// recently edited ones — and says that is the ordering.
export function recentWorkflows(workflows: WorkflowEntry[]): WorkflowEntry[] {
  return [...workflows].sort((a, b) => b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name))
}

// Which projects a session with this skill/workflow can open in. A
// project-scoped one exists only in its own project's .claude folder; a
// global one (or a skill with no entry on disk — a plugin skill the usage
// index saw invoked) can run anywhere. The pinned sandbox stays a valid
// target: it is a real project you can open a session in.
export function launchTargets(
  entries: { projectId: string | null }[],
  projects: RegistryEntry[],
): RegistryEntry[] {
  if (entries.length === 0 || entries.some((e) => e.projectId === null)) return projects
  const ids = new Set(entries.map((e) => e.projectId))
  return projects.filter((p) => ids.has(p.id))
}

export function skillEntriesFor(skills: SkillEntry[], name: string): SkillEntry[] {
  return skills.filter((s) => s.name === name)
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
