import { useSyncExternalStore } from 'react'
import { THEME_IDS, type ThemeId } from '../../../shared/ipc-types'

export const THEMES: { id: ThemeId; label: string; note: string }[] = [
  { id: 'nord', label: 'Nord', note: 'Dark, cool blue-grey' },
  { id: 'catppuccin', label: 'Catppuccin', note: 'Dark, soft mauve' },
  { id: 'clay', label: 'Clay', note: 'Light, rounded and soft' },
]

const KEY = 'claude-hub:theme'
const listeners = new Set<() => void>()

function read(): ThemeId {
  try {
    const stored = localStorage.getItem(KEY)
    if (THEME_IDS.includes(stored as ThemeId)) return stored as ThemeId
  } catch {
    // Storage unavailable — fall back to the default.
  }
  return 'nord'
}

let current: ThemeId = read()

// Sets <html data-theme> and recolours the native window controls. main.tsx
// calls this once before the first render so there is no flash of the
// default theme.
export function applyTheme(theme: ThemeId): void {
  current = theme
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  // Cosmetic: a failure leaves the native buttons in the previous colours.
  window.hubApi?.setWindowTheme(theme).catch(() => {})
  for (const l of listeners) l()
}

export function initTheme(): void {
  applyTheme(current)
}

export function useTheme(): [ThemeId, (theme: ThemeId) => void] {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
  return [theme, applyTheme]
}
