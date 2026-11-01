// Session Desktop, Electron glue: pushes desktop-core.ts's snapshots and
// terminal output to every hub window (the main one and each pop-out), owns
// the pop-out windows, and fires "<name> needs you" when a session starts
// waiting on a choice while no hub window is focused.
import { BrowserWindow, Notification } from 'electron'
import { IPC_CHANNELS, type DesktopSnapshot } from '../shared/ipc-types'
import { disposeDesktopCore, initDesktopCore, onDesktopData, onDesktopSnapshot, poppableName, setPoppedOut } from './desktop-core'
import { needsYouTransitions } from './desktop-model'

export interface DesktopWindowOptions {
  hostScript: string // dist-electron/desktop-host.js
  preload: string // the main window's preload
  // Loads the renderer into a window, at a hash route when given. main.ts
  // owns the dev-server-or-dist choice.
  loadRenderer: (win: BrowserWindow, hash?: string) => void
  // CLAUDE_HUB_HIDDEN_WINDOW: pop-outs render offscreen and never take focus,
  // and no notification is shown.
  hidden: boolean
}

let unsubscribe: Array<() => void> = []
let mainWin: BrowserWindow | null = null
let options: DesktopWindowOptions | null = null
const popouts = new Map<string, BrowserWindow>()

function hubWindows(): BrowserWindow[] {
  return [mainWin, ...popouts.values()].filter((w): w is BrowserWindow => w !== null && !w.isDestroyed())
}

// Same guard as main.ts sendToRenderer: a destroyed window throws on send.
function broadcast(channel: string, payload: unknown): void {
  for (const w of hubWindows()) w.webContents.send(channel, payload)
}

function closePopouts(): void {
  for (const w of popouts.values()) if (!w.isDestroyed()) w.close()
}

function reveal(w: BrowserWindow | null | undefined): void {
  if (!w || w.isDestroyed() || options?.hidden) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

export function initDesktop(win: BrowserWindow, opts: DesktopWindowOptions): void {
  disposeDesktop()
  mainWin = win
  options = opts
  // Pop-outs close with the main window, so the app still quits with it.
  win.on('closed', closePopouts)
  let prev: DesktopSnapshot | null = null
  unsubscribe = [
    onDesktopSnapshot((snapshot) => {
      broadcast(IPC_CHANNELS.desktopUpdate, snapshot)
      for (const [id, w] of popouts) {
        if (w.isDestroyed()) continue
        const session = snapshot.sessions.find((s) => s.id === id)
        // Forgotten: nothing left to show. (An unreadable records file lists
        // no sessions at all, which isn't a forget.)
        if (!session && !snapshot.records.error) w.close()
        else if (session && w.getTitle() !== session.name) w.setTitle(session.name)
      }
      // A hidden (automation) run never notifies: the toasts would be the
      // real app's duplicates, or a test's.
      if (!opts.hidden && !hubWindows().some((w) => w.isFocused()) && Notification.isSupported()) {
        for (const session of needsYouTransitions(prev, snapshot)) {
          const notification = new Notification({ title: `${session.name} needs you`, body: session.stateDetail ?? '' })
          notification.on('click', () => reveal(popouts.get(session.id) ?? mainWin))
          notification.show()
        }
      }
      prev = snapshot
    }),
    onDesktopData((chunk) => broadcast(IPC_CHANNELS.desktopData, chunk)),
  ]
  initDesktopCore({ hostScript: opts.hostScript, execPath: process.execPath })
}

// On quit: close the pipe only. The host and its sessions keep running.
export function disposeDesktop(): void {
  for (const off of unsubscribe) off()
  unsubscribe = []
  disposeDesktopCore()
}

// Show a running session in its own window (the renderer's
// #/desktop-tile/<id> route), or bring its existing window forward.
export async function popOutDesktopSession(id: string): Promise<void> {
  if (!options) throw new Error('Session Desktop is not initialised')
  if (typeof id !== 'string') throw new Error('No such desktop session')
  const name = poppableName(id)
  const existing = popouts.get(id)
  if (existing && !existing.isDestroyed()) return reveal(existing)
  const hidden = options.hidden
  const w = new BrowserWindow({
    width: 900,
    height: 600,
    title: name,
    ...(hidden && { show: false, focusable: false, skipTaskbar: true }),
    webPreferences: { preload: options.preload, offscreen: hidden, backgroundThrottling: !hidden },
  })
  popouts.set(id, w)
  setPoppedOut(id, true)
  // The window is titled by its session, not the page.
  w.on('page-title-updated', (event) => event.preventDefault())
  w.on('closed', () => {
    popouts.delete(id)
    setPoppedOut(id, false)
  })
  options.loadRenderer(w, `/desktop-tile/${encodeURIComponent(id)}`)
}
