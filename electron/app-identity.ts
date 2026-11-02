// The hub's Windows identity. Run from source, the process is electron.exe,
// so without an explicit AppUserModelID Windows files the taskbar button and
// notifications under Electron, and pinning it pins bare electron.exe. A Start
// Menu shortcut carrying the same ID gives them claude-hub's name and icon and
// makes a pin relaunch the hub. main.ts sets the ID and creates the shortcut;
// footprint.ts reports it. Electron-free so the footprint can read it.
import os from 'node:os'
import path from 'node:path'

export const APP_ID = 'com.pcampb33.claude-hub'

export function startMenuShortcutPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'claude-hub.lnk')
}

// What the shortcut launches: scripts/start-hub.vbs through wscript, which has
// no console, so starting the hub opens no window but the hub's own.
export function shortcutDetails(appRoot: string) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return {
    target: path.join(systemRoot, 'System32', 'wscript.exe'),
    args: `//B //Nologo "${path.join(appRoot, 'scripts', 'start-hub.vbs')}"`,
    cwd: appRoot,
    icon: path.join(appRoot, 'public', 'icon.ico'),
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'claude-hub',
  }
}
