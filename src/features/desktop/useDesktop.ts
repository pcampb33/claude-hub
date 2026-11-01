import { useCallback, useEffect, useState } from 'react'
import type { DesktopSnapshot } from '../../../shared/ipc-types'

export type DesktopState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'data'; snapshot: DesktopSnapshot }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// The desktop snapshot: seeded by getDesktop(), kept fresh by the
// desktop:update push. Subscribes before fetching, and a push that lands
// before the fetch resolves wins (it is the newer of the two).
export function useDesktop(): { state: DesktopState; retry: () => void } {
  const [state, setState] = useState<DesktopState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    let pushed = false
    const off = window.hubApi.onDesktopUpdate((snapshot) => {
      pushed = true
      if (live) setState({ status: 'data', snapshot })
    })
    window.hubApi.getDesktop().then(
      (snapshot) => {
        if (live && !pushed) setState({ status: 'data', snapshot })
      },
      (err: unknown) => {
        if (live && !pushed) setState({ status: 'error', error: message(err) })
      },
    )
    return () => {
      live = false
      off()
    }
  }, [attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  return { state, retry }
}

// The rail badge: how many sessions are waiting on a choice. null = not known
// (still loading, or the read failed), which the badge renders as nothing,
// the same as zero, because a rail badge has no room to explain itself; the
// Desktop view says what it couldn't reach.
export function useDesktopNeedsCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    let pushed = false
    const count = (snapshot: DesktopSnapshot) => snapshot.sessions.filter((s) => s.state === 'needs-you').length
    const off = window.hubApi.onDesktopUpdate((snapshot) => {
      pushed = true
      if (live) setCount(count(snapshot))
    })
    window.hubApi.getDesktop().then(
      (snapshot) => {
        if (live && !pushed) setCount(count(snapshot))
      },
      () => {
        if (live && !pushed) setCount(null)
      },
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return count
}
