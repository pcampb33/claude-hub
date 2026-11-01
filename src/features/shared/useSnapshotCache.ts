import { useCallback, useRef, useState } from 'react'

// localStorage-backed cache of a fetched value, so a cold load paints the last
// known data immediately instead of placeholders.
//
// Deliberately NOT usePersistentState: that one is sessionStorage, which resets
// on relaunch — exactly the load with no previous paint to keep. Anything
// cached here is shown as if current until the live
// fetch lands, so callers must surface `restoredAt` to the user (see the
// dashboard's stale marker); a silent stale number is worse than a placeholder.
//
// The key is versioned by the caller. A shape change between app versions would
// otherwise rehydrate a stale shape into a component that no longer renders it.

interface Envelope<T> {
  at: string // ISO timestamp of the write
  value: T
}

export function useSnapshotCache<T>(key: string, initial: T) {
  // Read once on mount; later reads would race the writes below.
  const restored = useRef<Envelope<T> | null>(null)
  if (restored.current === null) {
    try {
      const stored = localStorage.getItem(key)
      const parsed = stored === null ? null : (JSON.parse(stored) as Envelope<T>)
      if (parsed && typeof parsed.at === 'string' && 'value' in parsed) restored.current = parsed
    } catch {
      // Corrupt or absent — fall through to the initial value.
    }
  }

  const [value, setValueState] = useState<T>(() => restored.current?.value ?? initial)
  // Non-null only while the value on screen is the restored one. Cleared by the
  // first fresh write, which is what ends the stale marker.
  const [restoredAt, setRestoredAt] = useState<string | null>(restored.current?.at ?? null)

  const setValue = useCallback(
    (next: T) => {
      setValueState(next)
      setRestoredAt(null)
      try {
        localStorage.setItem(key, JSON.stringify({ at: new Date().toISOString(), value: next } satisfies Envelope<T>))
      } catch {
        // Quota or private mode — the app still works, it just won't rehydrate.
      }
    },
    [key],
  )

  return [value, setValue, restoredAt] as const
}
