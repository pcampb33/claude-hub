import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalConfigReport } from '../../../shared/ipc-types'

// Fetch + actions for the Global view. Same three-state fetch shape as
// useFloorStatus (loading / error / data — a rejected invoke must never leave
// the view claiming there is nothing configured), plus the two actions, which
// keep their own error so a failed "Run now" doesn't blank the page.
export function useGlobalConfig() {
  const [report, setReport] = useState<GlobalConfigReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const latestCall = useRef(0)

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const callId = ++latestCall.current
    if (!opts?.silent) setLoading(true)
    try {
      const result = await window.hubApi.getGlobalConfig()
      if (callId !== latestCall.current) return
      setReport(result)
      setError(null)
    } catch (err) {
      if (callId !== latestCall.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (callId === latestCall.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The main process returns the refreshed report, so the row re-grades from a
  // fresh probe rather than from an assumption that starting the task worked.
  const runTask = useCallback(async (taskName: string) => {
    setBusyTask(taskName)
    setActionError(null)
    try {
      const result = await window.hubApi.runGlobalTask(taskName)
      setReport(result)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyTask(null)
    }
  }, [])

  const openFile = useCallback(async (fileId: string) => {
    setActionError(null)
    try {
      await window.hubApi.openGlobalFile(fileId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return { report, loading, error, refresh, runTask, busyTask, actionError, openFile }
}
