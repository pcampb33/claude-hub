import { useEffect, useState } from 'react'

// useState backed by sessionStorage so per-view UI state (search query,
// selected note, form inputs) survives view switches within a session but
// resets on relaunch. Values must be JSON-serializable.
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key)
      if (stored !== null) return JSON.parse(stored) as T
    } catch {
      // Corrupt entry — fall through to the initial value.
    }
    return initial
  })

  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue] as const
}
