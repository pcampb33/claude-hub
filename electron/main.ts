import { app, BrowserWindow, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { registerAllIpcHandlers } from './ipc-handlers'
import { initLiveStatus, disposeLiveStatus } from './live'
import { initDesktop, disposeDesktop } from './desktop'
import { onJobsChanged } from './sandbox-jobs'
import { onVerifyJobsChanged } from './verify-jobs'
import { IPC_CHANNELS } from '../shared/ipc-types'
import { loadWindowBounds, trackWindowBounds } from './window-state'
import { DEFAULT_OVERLAY } from './window-theme'
import { claimInstance, instancePipe } from './instance-lock'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// registry.ts reads process.env.APP_ROOT lazily (inside function calls, not
// at module load), so it's safe for ipc-handlers.ts to import it above even
// though APP_ROOT is only set at this point in main.ts's own execution.
registerAllIpcHandlers()

// No File/Edit/View/Window/Help menu bar — this is a single-purpose local
// tool, not an app whose users need those menus. Removing the application
// menu entirely (not just autoHideMenuBar) means Alt doesn't reveal it either.
Menu.setApplicationMenu(null)

let win: BrowserWindow | null

// Push to the renderer only when the window is alive. On macOS the window can
// be closed while the app stays running (window-all-closed doesn't quit there),
// leaving `win` pointing at a DESTROYED BrowserWindow — a bare send() then
// throws "Object has been destroyed" out of a subprocess callback that no
// IPC try/catch covers. Mirrors live.ts's isDestroyed guard.
function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// CLAUDE_HUB_HIDDEN_WINDOW=1 (scripts/screenshot-app.mjs sets it): a window
// that is never shown and can't take focus, at a fixed size that isn't saved,
// so automated checks never pull focus from whatever the user is doing.
const HIDDEN_WINDOW = process.env.CLAUDE_HUB_HIDDEN_WINDOW === '1'

// The renderer, from the dev server or the built dist, at an optional hash
// route (a desktop pop-out loads '#/desktop-tile/<id>').
function loadRenderer(target: BrowserWindow, hash?: string): void {
  if (VITE_DEV_SERVER_URL) {
    target.loadURL(hash ? `${VITE_DEV_SERVER_URL}#${hash}` : VITE_DEV_SERVER_URL)
  } else {
    target.loadFile(path.join(RENDERER_DIST, 'index.html'), hash ? { hash } : undefined)
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...(HIDDEN_WINDOW ? { width: 1500, height: 950, show: false, focusable: false, skipTaskbar: true } : loadWindowBounds()),
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    // Frameless with native Windows overlay controls. Starts in the default
    // theme's colours; the renderer recolours them to the saved theme on load
    // (window-theme.ts). Height matches the renderer's 36px titlebar strip
    // (TitleBar.tsx) so the native buttons span exactly that bar.
    titleBarStyle: 'hidden',
    titleBarOverlay: DEFAULT_OVERLAY,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // Hidden mode renders offscreen: no OS window exists to take focus, and
      // unlike a merely hidden window it keeps producing frames to capture.
      offscreen: HIDDEN_WINDOW,
      backgroundThrottling: !HIDDEN_WINDOW,
    },
  })
  if (!HIDDEN_WINDOW) trackWindowBounds(win)

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  loadRenderer(win)

  // Transcript watcher + tray + live:update pushes (electron/live.ts).
  initLiveStatus(win)

  // Session Desktop: reattach to a running pty host, relay its pushes to this
  // window and its pop-outs.
  initDesktop(win, { hostScript: path.join(__dirname, 'desktop-host.js'), preload: path.join(__dirname, 'preload.mjs'), loadRenderer, hidden: HIDDEN_WINDOW })

  // Push side of the sandbox jobs surface — sandbox-jobs.ts stays
  // Electron-free; the webContents coupling lives here, like live.ts's win.
  onJobsChanged((jobs) => sendToRenderer(IPC_CHANNELS.sandboxJobsChanged, jobs))
  onVerifyJobsChanged((jobs) => sendToRenderer(IPC_CHANNELS.verifyJobsChanged, jobs))
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('will-quit', () => {
  disposeLiveStatus()
  disposeDesktop()
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// One hub per APP_ROOT (instance-lock.ts); a second launch brings this one
// forward and exits. The passive screenshot instance is the sanctioned
// second one: it only shows, never writes.
function comeForward(): void {
  if (!win || win.isDestroyed() || HIDDEN_WINDOW) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

app.whenReady().then(async () => {
  if (process.env.CLAUDE_HUB_DESKTOP_PASSIVE !== '1') {
    const claim = await claimInstance(instancePipe(process.env.APP_ROOT!), comeForward)
    if (claim.kind === 'second') return app.exit(0)
    if (claim.kind === 'unknown') console.error(`[claude-hub] Couldn't check for another running hub, starting anyway: ${claim.error}`)
  }
  createWindow()
})
