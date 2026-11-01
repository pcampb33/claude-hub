import { useCallback, useEffect, useRef, useState } from 'react'

// A live skill surfaced as a /command — fed by listSkills() + the usage
// index, deduped by name (a skill installed in several places is one
// command). count backs the "used N×" meta; runProjectId is where Run ↗
// opens the session — the skill's own project, or (for globals) the project
// of its most recent invocation. null = no unambiguous cwd, Run hidden.
export interface LiveSkillRow {
  name: string
  description: string
  count: number
  runProjectId: string | null
}

// One row model for both halves of the catalog — the live skills read off disk
// and the hand-curated built-in table. Same fields either way, so a row is a
// row wherever you land in the list and the detail pane has one shape to
// render. `name` is the bare slug; the leading slash is presentation.
export interface CommandItem {
  // 'skill:<name>' / 'builtin:<name>' — a user skill may legitimately shadow a
  // built-in name, and the two are different rows.
  id: string
  name: string
  description: string
  group: string
  live: boolean
  // Three states on purpose: a count, 0 for a live skill nothing has invoked,
  // and null for a built-in, where nothing on disk records the command being
  // typed. null must never render as "never used".
  usageCount: number | null
  runProjectId: string | null
}

// Data hook for the Commands view's live-skills group: fetch + dedup-by-name
// merge + usage-desc sort live here so index.tsx stays composition-only
// (the feature-slice pattern useSkillsList/useWorkflows follow).
export function useCommands() {
  const [liveSkills, setLiveSkills] = useState<LiveSkillRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    try {
      const [list, usage] = await Promise.all([window.hubApi.listSkills(), window.hubApi.getSkillUsage()])
      if (requestId !== latestRequest.current) return
      const usageByName = new Map(usage.map((u) => [u.skill, u]))
      const seen = new Set<string>()
      const rows: LiveSkillRow[] = []
      for (const s of list) {
        if (seen.has(s.name)) continue
        seen.add(s.name)
        const use = usageByName.get(s.name)
        rows.push({
          name: s.name,
          description: s.description ?? '',
          count: use?.count ?? 0,
          runProjectId: s.projectId ?? use?.invocations.find((i) => i.projectId)?.projectId ?? null,
        })
      }
      rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      setLiveSkills(rows)
      setError(null)
    } catch (err) {
      // Swallowing this left an empty live group, which reads as "you have no
      // skills" when nobody actually found out — say so instead, and keep the
      // static reference rendering below it.
      if (requestId !== latestRequest.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId === latestRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { liveSkills, loading, error, refresh }
}
