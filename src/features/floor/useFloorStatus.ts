import { useCallback, useEffect, useRef, useState } from 'react'
import type { FloorStatusReport, ProjectFloorStatus } from '../../../shared/ipc-types'

// The scheduled recorder runs daily, so a floor with no run in 48h is one two
// scheduled runs failed to reach.
export const FLOOR_STALE_MS = 48 * 60 * 60 * 1000

export type FloorState = 'green' | 'red' | 'unverified'

// Every view that makes a claim about a floor reads it through here, so
// "green" means the same thing on all of them. A green run nobody has
// repeated since FLOOR_STALE_MS is 'unverified', not 'green': "passed when
// last checked, weeks ago" and "passing" are different facts, and only one of
// them is a guarantee. Same for a configured floor that has never run at all.
export function floorState(project: ProjectFloorStatus, nowMs: number): FloorState {
  if (!project.latest) return 'unverified'
  if (!project.latest.ok) return 'red'
  return nowMs - new Date(project.latest.timestamp).getTime() > FLOOR_STALE_MS ? 'unverified' : 'green'
}

// One-shot fetch of the floor-status report — same fetch/loading/refresh
// shape as useAllProjectsStatus, minus the fan-out (getFloorStatus already
// covers every registered project in a single IPC call).
export function useFloorStatus() {
  const [report, setReport] = useState<FloorStatusReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latestCall = useRef(0)

  // silent: background auto-refresh — skip the loading flip so the gauge
  // doesn't flash a loading state on every quiet poll. The finally still
  // clears loading if a manual refresh was in flight.
  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const callId = ++latestCall.current
    if (!opts?.silent) setLoading(true)
    try {
      const result = await window.hubApi.getFloorStatus()
      // A newer refresh() started while this one was in flight — its result
      // will land instead, so don't let this stale one overwrite it.
      if (callId !== latestCall.current) return
      setReport(result)
      setError(null)
    } catch (err) {
      // A rejected invoke (e.g. hand-mangled registry.json — the setup path
      // this feature itself directs users down) must not strand the view on
      // a disabled "Loading…" forever; surface it and leave Refresh usable.
      if (callId !== latestCall.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (callId === latestCall.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { report, loading, error, refresh }
}
