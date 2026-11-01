import fs from 'node:fs'
import path from 'node:path'
import { screen, type BrowserWindow, type Rectangle } from 'electron'

// Hand-rolled rather than a dependency (e.g. electron-window-state) —
// matches the project's near-zero-dependency convention (gpt-tokenizer
// remains the one deliberate exception). Stored next to registry.json,
// same "machine-specific, not portable source" category.
function windowStatePath(): string {
  return path.join(process.env.APP_ROOT!, 'window-state.json')
}

export function loadWindowBounds(): Rectangle | null {
  try {
    const filePath = windowStatePath()
    if (!fs.existsSync(filePath)) return null
    const bounds = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Rectangle

    // Only trust saved bounds if they'd actually land on a currently
    // connected display's work area — a saved position from a since-
    // disconnected second monitor would otherwise put the window
    // off-screen with no way to drag it back.
    const onScreen = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        bounds.x >= area.x &&
        bounds.y >= area.y &&
        bounds.x < area.x + area.width &&
        bounds.y < area.y + area.height
      )
    })
    return onScreen ? bounds : null
  } catch (err) {
    console.error('[window-state] failed to load, using default bounds:', err)
    return null
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    // getNormalBounds(), not getBounds(): a maximized window reports bounds
    // offset by the border (x=y=-8 on Windows), which then fails loadWindow-
    // Bounds' on-screen check (-8 >= 0) and silently reverts to the default
    // rectangle on every launch. getNormalBounds() is the restored position and
    // equals getBounds() when the window isn't maximized/minimized.
    fs.writeFileSync(windowStatePath(), JSON.stringify(win.getNormalBounds()))
  } catch (err) {
    console.error('[window-state] failed to save:', err)
  }
}

// Debounced — 'resize'/'move' fire continuously while dragging, writing to
// disk on every event would be wasteful and could race with itself.
export function trackWindowBounds(win: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | undefined
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowBounds(win), 500)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('close', () => {
    clearTimeout(saveTimer)
    saveWindowBounds(win)
  })
}
