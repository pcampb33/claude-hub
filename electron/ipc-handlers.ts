import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-types'
import { hubService } from './hub-service'
import {
  openFolder,
  copyPath,
  launchWorkflowSession,
  launchWorkflowExplain,
  launchWorkflowEdit,
  launchCommandSession,
} from './launch'
import { openVault } from './vault'
import { deleteSession } from './session-delete'
import { pickFolder } from './dialog'
import { overlayFor } from './window-theme'
import { popOutDesktopSession } from './desktop'

// The single Electron-coupled registration boundary. The bulk of the hubApi
// surface lives in hub-service.ts as an Electron-free channel→handler map —
// registered here in one loop. Only handlers that need Electron APIs (shell,
// clipboard, native dialog) are registered individually below;
// hub-service.test.ts asserts the two sets exactly cover the contract.
// Centralizing every ipcMain.handle() call here (and keeping 'electron'
// imports out of the domain modules) is what makes CLI-script reuse
// possible at all — 'electron' has no real exports when required outside
// Electron's own process.
export function registerAllIpcHandlers(): void {
  for (const [channel, handler] of Object.entries(hubService)) {
    // Each handler's real signature is enforced against HubApi where the map
    // is defined (hub-service.ts); at this generic boundary the spread from
    // the wire is necessarily untyped.
    ipcMain.handle(channel, (_event, ...args) => (handler as (...args: unknown[]) => unknown)(...args))
  }

  // Electron-coupled handlers (ELECTRON_ONLY_CHANNELS in hub-service.ts).
  ipcMain.handle(IPC_CHANNELS.openFolder, (_event, id: string) => openFolder(id))
  ipcMain.handle(IPC_CHANNELS.copyPath, (_event, id: string) => copyPath(id))
  ipcMain.handle(IPC_CHANNELS.openVault, () => openVault())
  ipcMain.handle(IPC_CHANNELS.deleteSession, (_event, projectId: string, sessionId: string) =>
    deleteSession(projectId, sessionId),
  )
  ipcMain.handle(IPC_CHANNELS.pickFolder, () => pickFolder())
  ipcMain.handle(
    IPC_CHANNELS.launchWorkflowSession,
    (_event, sourcePath: string, targetProjectId: string, args: string) =>
      launchWorkflowSession(sourcePath, targetProjectId, args),
  )
  ipcMain.handle(IPC_CHANNELS.explainWorkflowSession, (_event, sourcePath: string, targetProjectId: string) =>
    launchWorkflowExplain(sourcePath, targetProjectId),
  )
  ipcMain.handle(
    IPC_CHANNELS.editWorkflowSession,
    (_event, scriptPath: string, targetProjectId: string, instruction: string) =>
      launchWorkflowEdit(scriptPath, targetProjectId, instruction),
  )
  ipcMain.handle(IPC_CHANNELS.launchCommandSession, (_event, commandName: string, targetProjectId: string) =>
    launchCommandSession(commandName, targetProjectId),
  )
  ipcMain.handle(IPC_CHANNELS.setWindowTheme, (event, theme: unknown) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(overlayFor(theme))
  })
  ipcMain.handle(IPC_CHANNELS.popOutDesktopSession, (_event, id: string) => popOutDesktopSession(id))
}
