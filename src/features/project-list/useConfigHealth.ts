import { useCallback, useState } from 'react'
import type { ConfigHealthReport } from '../../../shared/ipc-types'

export function useConfigHealth(projectPath: string) {
  const [report, setReport] = useState<ConfigHealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // try/catch/finally rather than a bare await, for the reason useProjectFanOut
  // spells out: a rejected scan left setLoading(false) unreachable, so the ring
  // read "scanning…" for the rest of the session. A permanent spinner is a
  // worse lie than a stated failure — it never resolves and never explains.
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await window.hubApi.getConfigHealth(projectPath))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  return { report, loading, error, load }
}
