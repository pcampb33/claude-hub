import { useEffect, useState } from 'react'

// Tiny module-level pub-sub so the nav's status LED can breathe while any
// view is loading, without threading props through every feature. Views
// report their loading flag via useReportLoading; App observes the count.

let activeCount = 0
const listeners = new Set<(busy: boolean) => void>()

function notify() {
  const busy = activeCount > 0
  for (const listener of listeners) listener(busy)
}

/** Report a view's loading flag into the shared "app is busy" signal. */
export function useReportLoading(loading: boolean) {
  useEffect(() => {
    if (!loading) return
    activeCount++
    notify()
    return () => {
      activeCount--
      notify()
    }
  }, [loading])
}

/** True while any view that reports loading is busy. */
export function useAppLoading(): boolean {
  const [busy, setBusy] = useState(activeCount > 0)
  useEffect(() => {
    listeners.add(setBusy)
    return () => {
      listeners.delete(setBusy)
    }
  }, [])
  return busy
}
