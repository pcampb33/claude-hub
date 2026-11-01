import { useCallback, useEffect, useRef, useState } from 'react'
import { sharedRead } from '../shared/sharedRead'

// Three states, never two (CLAUDE.md: a failure must not render as an
// absence). `data` survives a failed refresh so a widget can keep showing the
// last answer next to the error, but `error` is always surfaced.
export type HubRead<T> =
  | { status: 'loading'; data: undefined; error: null; refresh: () => void }
  | { status: 'error'; data: T | undefined; error: string; refresh: () => void }
  | { status: 'data'; data: T; error: null; refresh: () => void }

// After a mutation (an inbox entry added, a job run), call this with the
// read's key: every mounted reader of that key refetches past the cache, so
// the Inbox widget, Needs you and the headline all move together.
const invalidators = new Map<string, Set<() => void>>()
export function invalidateHubRead(key: string): void {
  for (const fn of invalidators.get(key) ?? []) fn()
}

// Every widget that reads the same channel uses the same key (see reads.ts),
// so a Home mount asks each question once: sharedRead joins in-flight reads
// and reuses an answer for 10s.
export function useHubRead<T>(key: string, read: () => Promise<T>): HubRead<T> {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'data'; data?: T; error: string | null }>({
    status: 'loading',
    error: null,
  })
  const readRef = useRef(read)
  readRef.current = read
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    (allowCached: boolean) => {
      sharedRead(key, () => readRef.current(), allowCached).then(
        (data) => {
          if (alive.current) setState({ status: 'data', data, error: null })
        },
        (err: unknown) => {
          if (alive.current)
            setState((prev) => ({
              status: 'error',
              data: prev.data,
              error: err instanceof Error ? err.message : String(err),
            }))
        },
      )
    },
    [key],
  )

  useEffect(() => run(true), [run])
  const refresh = useCallback(() => run(false), [run])
  useEffect(() => {
    let set = invalidators.get(key)
    if (!set) invalidators.set(key, (set = new Set()))
    set.add(refresh)
    return () => {
      set.delete(refresh)
    }
  }, [key, refresh])
  return { ...state, refresh } as HubRead<T>
}
