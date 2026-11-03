// Live intelligence: watches the transcript dirs of REGISTERED projects,
// pushes LiveStatusSnapshot updates to the renderer, fires native
// notifications on turn-end / hook-failure transitions, and owns the tray.
// This is the Electron-coupled composition layer over live-core.ts —
// keep every pure derivation (including snapshot assembly) there, not here.
import { BrowserWindow, Notification, Tray, nativeImage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeStatuses, notificationsFor, toSnapshot, type LiveSessionStatus } from './live-core'
import { onDesktopSnapshot } from './desktop-core'
import { IPC_CHANNELS } from '../shared/ipc-types'

// fs.watch({recursive}) is the latency win but is unreliable on OneDrive
// paths (several registered projects live there), so a polling sweep is
// the correctness guarantee and the watcher is best-effort on top.
const POLL_MS = 5_000
const WATCH_DEBOUNCE_MS = 500

let win: BrowserWindow | null = null
let tray: Tray | null = null
let watcher: fs.FSWatcher | null = null
let pollTimer: NodeJS.Timeout | null = null
let debounceTimer: NodeJS.Timeout | null = null
// Previous per-project status, for transition detection. null until the
// first sweep — startup state must never fire notifications.
let prev: Map<string, LiveSessionStatus> | null = null
let lastSerialized = ''
// Conversations the Desktop is running: it sends its own "needs you".
let desktopSessionIds: ReadonlySet<string> = new Set()
let stopDesktopWatch: (() => void) | null = null

// 16x16 terracotta tray icons, generated programmatically (PNG bytes
// inlined — the repo ships no raster app icon, and Windows trays can't
// take the public/*.svg). Ring = quiet, filled disc = a session is active.
const TRAY_IDLE = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAhUlEQVR4nK2TwQnAIAxFvWY6L0JGycFtnMcFsof3lkKEX1FpiYcPYpLHT4xBhYNHqwCpcFLhbEp29wnwFDQVvgY1i20BZVI4qqwAGZKqCkezTXauEM8jgMB2XfRLAGk9pwcT0ONm6hHyEgLQ/nTa4OLVxjGAuwX3EN3PeGSRjqzykc/0SzeBdvjgLFQXXAAAAABJRU5ErkJggg==',
)
const TRAY_ACTIVE = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbklEQVR4nGO4WR7OQAnGJcF5szw85GZ5eDUUh0DFiDIApOHLzfLw/2j4C1QOrwGLsGhEx4twGVBNhGYYrkY3gBOHs3HhL7AwgRkQQoJmGA5BNoAU56N4g2oGUOwFigOR4mikSkKiSlKmSmYiCQMAz7Arb5xa3PkAAAAASUVORK5CYII=',
)

function notify(title: string, body: string): void {
  // A hidden (offscreen) instance is never focused, so every turn end would
  // toast over whatever the user is doing (scripts/screenshot-app.mjs).
  if (process.env.CLAUDE_HUB_HIDDEN_WINDOW === '1') return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => {
    win?.show()
    win?.focus()
  })
  notification.show()
}

function detectTransitions(statuses: ReturnType<typeof computeStatuses>): void {
  // `?? true` preserves the original `win && !win.isFocused()`: with no window
  // at all, a turn-end ping is suppressed rather than fired into the void.
  for (const { title, body } of notificationsFor(prev, statuses, win?.isFocused() ?? true, desktopSessionIds)) {
    notify(title, body)
  }
}

function updateTray(statuses: ReturnType<typeof computeStatuses>): void {
  if (!tray) return
  const active = [...statuses.values()].filter(({ status }) => status.state === 'active' || status.state === 'waiting')
  tray.setImage(active.length > 0 ? TRAY_ACTIVE : TRAY_IDLE)
  tray.setToolTip(
    active.length > 0
      ? `claude-hub — ${active.map(({ entry, status }) => `${entry.name} ${status.state === 'waiting' ? 'needs you' : 'active'}`).join(', ')}`
      : 'claude-hub',
  )
}

function sweep(): void {
  // A queued poll/debounce tick can fire in the gap between window
  // destruction and disposeLiveStatus() clearing the timers on will-quit.
  if (win && win.isDestroyed()) return
  let statuses: ReturnType<typeof computeStatuses>
  try {
    statuses = computeStatuses()
  } catch {
    return // e.g. registry.json mid-edit — next poll retries
  }
  detectTransitions(statuses)
  updateTray(statuses)
  prev = new Map([...statuses].map(([id, { status }]) => [id, status]))

  const snapshot = toSnapshot(statuses)
  // Only push when something actually changed — the 5s poll would
  // otherwise spam identical snapshots at the renderer forever.
  const serialized = JSON.stringify(snapshot.projects)
  if (serialized === lastSerialized) return
  lastSerialized = serialized
  win?.webContents.send(IPC_CHANNELS.liveUpdate, snapshot)
}

export function initLiveStatus(mainWindow: BrowserWindow): void {
  win = mainWindow
  if (tray) return // window re-created (macOS activate) — keep the existing watcher/tray

  tray = new Tray(TRAY_IDLE)
  tray.setToolTip('claude-hub')
  tray.on('click', () => {
    win?.show()
    win?.focus()
  })

  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  try {
    watcher = fs.watch(projectsRoot, { recursive: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(sweep, WATCH_DEBOUNCE_MS)
    })
  } catch {
    // Root missing or recursive watch unavailable — the poll still covers us.
  }
  stopDesktopWatch = onDesktopSnapshot((snapshot) => {
    desktopSessionIds = new Set(snapshot.sessions.filter((s) => s.alive).map((s) => s.claudeSessionId))
  })
  pollTimer = setInterval(sweep, POLL_MS)
  sweep()
}

export function disposeLiveStatus(): void {
  stopDesktopWatch?.()
  stopDesktopWatch = null
  watcher?.close()
  watcher = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  tray?.destroy()
  tray = null
  win = null
}
