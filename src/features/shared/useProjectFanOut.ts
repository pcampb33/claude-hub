import { useCallback, useEffect, useRef, useState } from 'react'
import { useSnapshotCache } from './useSnapshotCache'
import { sharedRead } from './sharedRead'
import { readRegisteredProjects } from './useRegisteredProjects'
import type { RegistryEntry } from '../../../shared/ipc-types'

// The shape behind useAllProjectsStatus and useAllProjectsConfigHealth: list
// every registered project, fetch one thing per project, cache the result
// across launches, and let a newer refresh beat an in-flight older one.
//
// Pulled out because those two hooks were identical line for line and then
// changed in lockstep twice in a row — the snapshot cache, then its dependency
// — which is the drift a shared shape is supposed to prevent.
//
// useFloorStatus deliberately stays separate: no fan-out (one IPC call already
// covers every project) and a `silent` mode this doesn't have.
//
// fetchOne MUST be declared at module scope, never inline in the component: its
// identity feeds refresh's dependency array, so a fresh function each render
// would re-fetch forever.
// One fan-out per cache key, shared by every consumer that asks for it while
// it is in flight or while its answer is still fresh.
//
// Views are not unmounted when you navigate away — the outgoing one is still
// mounted when the incoming one mounts, and the incoming one's hooks run their
// mount effect. So arriving at the Dashboard from Projects re-issued both
// fleet fan-outs the Projects view had just finished: measured, 15 registry
// status calls plus 15 config-health calls, for data seconds old. (The note in
// useAllProjectsStatus claiming only one feature is ever mounted was wrong,
// which is how this went unnoticed.)
//
// Keyed by cacheKey rather than by hook instance: the same key means the same
// fetchOne over the same registry, so the second caller wants exactly the
// answer the first already has.
function sharedFanOut<Extra>(
  cacheKey: string,
  fetchOne: (entry: RegistryEntry) => Promise<Extra>,
  allowCached: boolean,
): Promise<Array<RegistryEntry & Extra>> {
  return sharedRead(
    cacheKey,
    async () => {
      const projects = await readRegisteredProjects()
      return Promise.all(projects.map(async (entry) => ({ ...entry, ...(await fetchOne(entry)) })))
    },
    allowCached,
  )
}

export function useProjectFanOut<Extra>(cacheKey: string, fetchOne: (entry: RegistryEntry) => Promise<Extra>) {
  const [entries, setEntries, restoredAt] = useSnapshotCache<Array<RegistryEntry & Extra>>(cacheKey, [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latestCall = useRef(0)

  const load = useCallback(async (allowCached: boolean) => {
    const callId = ++latestCall.current
    setLoading(true)
    try {
      const withExtra = await sharedFanOut(cacheKey, fetchOne, allowCached)
      // A newer refresh() started while this one was in flight — its result
      // will land instead, so don't let this stale one overwrite it.
      if (callId !== latestCall.current) return
      setEntries(withExtra)
      setError(null)
    } catch (err) {
      // Don't strand the view on a disabled "Loading…" (see useFloorStatus).
      if (callId !== latestCall.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (callId === latestCall.current) setLoading(false)
    }
  }, [cacheKey, fetchOne, setEntries])

  // Mounting is allowed to reuse a fresh answer; asking for a refresh is not.
  const refresh = useCallback(() => load(false), [load])

  useEffect(() => {
    void load(true)
  }, [load])

  return { entries, loading, error, refresh, restoredAt }
}
