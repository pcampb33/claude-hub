import { useCallback, useEffect, useRef, useState } from 'react'
import type { PromoteResult, SkillEntry, SkillInvocationRecord } from '../../../shared/ipc-types'

// A skill enriched with its invocation stats from the usage index. lastUsed is
// null when the skill has never been invoked in any session; invocations is
// the full newest-first record list behind the detail pane's evidence panel.
export type SkillWithUsage = SkillEntry & {
  usedCount: number
  lastUsed: string | null
  invocations: SkillInvocationRecord[]
}

export function useSkillsList() {
  const [skills, setSkills] = useState<SkillWithUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // sessionId → title, for the detail pane's "Recent invocations" links.
  // Best-effort: listAllSessions() caps at the newest sessions, so older
  // invocations stay unresolved and render as project+date rows.
  const [sessionTitles, setSessionTitles] = useState<Map<string, string> | null>(null)
  const latestRequest = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    // Kicked off alongside the skills fetch but never awaited — titles are
    // detail-pane garnish and must not delay the list. On failure the previous
    // map is kept (a failed call is not cached; the next refresh retries).
    window.hubApi.listAllSessions().then(
      (list) => {
        if (requestId === latestRequest.current) setSessionTitles(new Map(list.map((e) => [e.sessionId, e.title])))
      },
      () => {},
    )
    try {
      // Usage is a separate, heavier scan than the cheap skill enumeration, so
      // it's its own channel — fetch both and merge by name here, keeping
      // listSkills() fast for its other caller (promote path validation).
      const [list, usage] = await Promise.all([window.hubApi.listSkills(), window.hubApi.getSkillUsage()])
      if (requestId !== latestRequest.current) return
      const byName = new Map(usage.map((u) => [u.skill, u]))
      const merged: SkillWithUsage[] = list.map((s) => {
        const u = byName.get(s.name)
        return { ...s, usedCount: u?.count ?? 0, lastUsed: u?.lastUsed || null, invocations: u?.invocations ?? [] }
      })
      // Recently-used first: skills with a lastUsed sort by it desc, never-used
      // sink below, and ties/never-used fall back to folder mtime desc.
      merged.sort((a, b) => {
        if (a.lastUsed && b.lastUsed) return b.lastUsed.localeCompare(a.lastUsed)
        if (a.lastUsed) return -1
        if (b.lastUsed) return 1
        return b.mtime.localeCompare(a.mtime)
      })
      setSkills(merged)
      setError(null)
    } catch (err) {
      // A rejected invoke must not strand the view on a disabled "Loading…"
      // forever (see useFloorStatus) — surface it and leave Refresh usable.
      if (requestId !== latestRequest.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId === latestRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const promote = useCallback(
    (sourcePath: string, targetProjectId: string): Promise<PromoteResult> =>
      window.hubApi.promoteToProject(sourcePath, targetProjectId),
    [],
  )

  const promoteAndTailor = useCallback(
    (sourcePath: string, targetProjectId: string): Promise<PromoteResult> =>
      window.hubApi.promoteAndTailor(sourcePath, targetProjectId),
    [],
  )

  const promoteToGlobal = useCallback(
    (sourcePath: string): Promise<PromoteResult> => window.hubApi.promoteSkillToGlobal(sourcePath),
    [],
  )

  const readSource = useCallback((skillPath: string): Promise<string> => window.hubApi.readSkillSource(skillPath), [])

  return { skills, sessionTitles, loading, error, refresh, promote, promoteAndTailor, promoteToGlobal, readSource }
}
