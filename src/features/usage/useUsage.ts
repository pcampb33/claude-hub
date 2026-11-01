import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageGranularity, UsageReport, UsageSessionsReport } from '../../../shared/ipc-types'

// While the main process is still building the index, re-read on this
// cadence so the progress bar moves and the chart appears by itself.
const INDEXING_POLL_MS = 1000

export type UsageState =
  | { status: 'loading'; data: undefined; error: null }
  // A failed read keeps the last report beside the error: it was true when
  // read, and the error is always shown with it.
  | { status: 'error'; data: UsageReport | undefined; error: string }
  | { status: 'data'; data: UsageReport; error: null }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function useUsage(granularity: UsageGranularity, periods: number) {
  const [state, setState] = useState<UsageState>({ status: 'loading', data: undefined, error: null })
  const [refreshing, setRefreshing] = useState(false)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    setRefreshing(true)
    try {
      const data = await window.hubApi.getUsage({ granularity, periods })
      if (ticket === latest.current) setState({ status: 'data', data, error: null })
    } catch (err) {
      if (ticket === latest.current) setState((prev) => ({ status: 'error', data: prev.data, error: messageOf(err) }))
    } finally {
      if (ticket === latest.current) setRefreshing(false)
    }
  }, [granularity, periods])

  useEffect(() => {
    // A new granularity starts from loading: the previous report's buckets
    // would be drawn under the new granularity's labels.
    setState({ status: 'loading', data: undefined, error: null })
    void load()
    const tickets = latest
    return () => {
      tickets.current++ // drop answers that land after unmount or a granularity switch
    }
  }, [load])

  const indexing = state.data?.state === 'indexing'
  useEffect(() => {
    if (!indexing || refreshing) return
    const t = setTimeout(() => void load(), INDEXING_POLL_MS)
    return () => clearTimeout(t)
  }, [indexing, refreshing, state, load])

  return { state, refreshing, reload: load }
}

export interface DrillTarget {
  key: string
  name: string
  startIso: string
  endIso: string
  label: string // the period it covers, in words
}

export type DrillState =
  | { status: 'loading'; data: undefined; error: null }
  | { status: 'error'; data: undefined; error: string }
  | { status: 'data'; data: UsageSessionsReport; error: null }

export function useUsageSessions(target: DrillTarget | null) {
  const [state, setState] = useState<DrillState>({ status: 'loading', data: undefined, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!target) return
    let live = true
    setState({ status: 'loading', data: undefined, error: null })
    window.hubApi.getUsageSessions(target.key, target.startIso, target.endIso).then(
      (data) => live && setState({ status: 'data', data, error: null }),
      (err) => live && setState({ status: 'error', data: undefined, error: messageOf(err) }),
    )
    return () => {
      live = false
    }
  }, [target, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { state, retry }
}
