import { THEME_IDS, type ThemeId } from '../shared/ipc-types'

// Native window-control colours per theme: each theme's --bg-sidebar and
// --text-secondary (src/index.css). The renderer sends only a theme id, so
// nothing it says reaches setTitleBarOverlay except a value from this table.
const OVERLAY: Record<ThemeId, { color: string; symbolColor: string }> = {
  nord: { color: '#272c36', symbolColor: '#c0c8d6' },
  catppuccin: { color: '#181825', symbolColor: '#a6adc8' },
  clay: { color: '#e4dcf8', symbolColor: '#5a4e85' },
}

export const DEFAULT_OVERLAY = { ...OVERLAY.nord, height: 36 }

export function overlayFor(theme: unknown): { color: string; symbolColor: string; height: number } {
  if (!THEME_IDS.includes(theme as ThemeId)) throw new Error(`Unknown theme: ${String(theme)}`)
  return { ...OVERLAY[theme as ThemeId], height: 36 }
}
