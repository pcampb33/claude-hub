import { useCallback, useEffect, useRef, useState } from 'react'
import type { DraftLearningsResult, ExperimentEntry, QueueToInboxResult } from '../../../shared/ipc-types'

export function useExperiments() {
  const [experiments, setExperiments] = useState<ExperimentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const latestRequest = useRef(0)

  // refresh() is called from three places (mount, after createExperiment,
  // after draftLearnings) — without a request-id guard, a slower earlier
  // call landing after a faster later one would silently revert the list
  // to stale data. Same pattern as useProjectList/usePromote.
  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    try {
      const result = await window.hubApi.listExperiments()
      if (requestId !== latestRequest.current) return
      setExperiments(result)
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled "Loading…" (see useFloorStatus).
      if (requestId !== latestRequest.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId === latestRequest.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createExperiment = useCallback(
    async (name: string): Promise<{ ok: boolean; message?: string }> => {
      setCreating(true)
      try {
        await window.hubApi.createExperiment(name)
        await refresh()
        return { ok: true }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      } finally {
        setCreating(false)
      }
    },
    [refresh],
  )

  const openTerminal = useCallback(
    (experimentPath: string): Promise<void> => window.hubApi.openExperimentTerminal(experimentPath),
    [],
  )

  const draftLearnings = useCallback(
    async (experimentPath: string): Promise<DraftLearningsResult> => {
      const result = await window.hubApi.draftLearnings(experimentPath)
      if (result.ok) await refresh()
      return result
    },
    [refresh],
  )

  const queueToInbox = useCallback(
    (experimentPath: string): Promise<QueueToInboxResult> => window.hubApi.queueExperimentToInbox(experimentPath),
    [],
  )

  return { experiments, loading, error, creating, refresh, createExperiment, openTerminal, draftLearnings, queueToInbox }
}
