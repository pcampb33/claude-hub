import { useCallback, useEffect, useState } from 'react'
import type { LiveStatusSnapshot } from '../../../../../shared/ipc-types'

export type LiveRead =
  | { status: 'loading'; snapshot: null; error: null; retry: () => void }
  | { status: 'error'; snapshot: null; error: string; retry: () => void }
  | { status: 'data'; snapshot: LiveStatusSnapshot; error: null; retry: () => void }

// Seed from getLiveStatus, then follow live:update pushes. Unlike the
// titlebar's useLiveStatus, a failed seed is an error state here: the widget
// must not sit on "loading" (or worse, "No live sessions") when the pull
// failed. A later push still replaces the error with data.
export function useLive(): LiveRead {
  const [state, setState] = useState<{ snapshot: LiveStatusSnapshot | null; error: string | null }>({
    snapshot: null,
    error: null,
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    // Subscribe before seeding so a push landing mid-seed is not lost.
    const unsubscribe = window.hubApi.onLiveUpdate((next) => {
      if (!cancelled) setState({ snapshot: next, error: null })
    })
    window.hubApi.getLiveStatus().then(
      (seed) => {
        // A push that arrived first is fresher than the seed.
        if (!cancelled) setState((s) => (s.snapshot ? s : { snapshot: seed, error: null }))
      },
      (err: unknown) => {
        if (!cancelled)
          setState((s) => (s.snapshot ? s : { snapshot: null, error: err instanceof Error ? err.message : String(err) }))
      },
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [attempt])

  const retry = useCallback(() => {
    setState({ snapshot: null, error: null })
    setAttempt((n) => n + 1)
  }, [])

  if (state.snapshot) return { status: 'data', snapshot: state.snapshot, error: null, retry }
  if (state.error) return { status: 'error', snapshot: null, error: state.error, retry }
  return { status: 'loading', snapshot: null, error: null, retry }
}

// A clock for elapsed times; the snapshot only changes when a transcript
// does, so an idle session's "18m" would otherwise freeze.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
