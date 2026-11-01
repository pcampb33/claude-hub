import { useEffect, useState } from 'react'
import type { LiveStatusSnapshot } from '../../../shared/ipc-types'

// Seeds from the live:get pull, then stays fresh via live:update pushes —
// no polling in the renderer, the main process owns the watch/poll loop.
export function useLiveStatus() {
  const [snapshot, setSnapshot] = useState<LiveStatusSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    // Subscribe before seeding: a push landing mid-seed must not be lost.
    // Pushes carry full snapshots, so the last writer always wins safely.
    const unsubscribe = window.hubApi.onLiveUpdate((next) => {
      if (!cancelled) setSnapshot(next)
    })
    window.hubApi.getLiveStatus().then(
      (seed) => {
        // A push that arrived after this seed was computed is fresher.
        if (!cancelled) setSnapshot((current) => current ?? seed)
      },
      () => {}, // seed failure is fine — the next push fills it in
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return snapshot
}
