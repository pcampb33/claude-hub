import { ipcRenderer, contextBridge } from 'electron'
import {
  IPC_CHANNELS,
  type HubApi,
  type LiveStatusSnapshot,
  type DesktopSnapshot,
  type DesktopTerminalChunk,
  type SandboxJob,
  type VerifyJob,
} from '../shared/ipc-types'
import { buildInvokeApi } from './preload-core.ts'

// Every request/response method is generated from the channel map (see
// preload-core.ts). What stays here is what actually differs: the three push
// subscriptions, each of which wraps a listener so the renderer never touches
// a raw channel name or an IpcRendererEvent, and returns its unsubscribe.
//
// The `HubApi` annotation still checks the whole surface — the spread carries
// 69 typed members in, so a method missing from either half is a tsc error.
const hubApi: HubApi = {
  ...buildInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args)),

  onSandboxJobsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, jobs: SandboxJob[]) => listener(jobs)
    ipcRenderer.on(IPC_CHANNELS.sandboxJobsChanged, wrapped)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.sandboxJobsChanged, wrapped)
    }
  },
  onVerifyJobsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, jobs: VerifyJob[]) => listener(jobs)
    ipcRenderer.on(IPC_CHANNELS.verifyJobsChanged, wrapped)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.verifyJobsChanged, wrapped)
    }
  },
  onLiveUpdate: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LiveStatusSnapshot) => listener(snapshot)
    ipcRenderer.on(IPC_CHANNELS.liveUpdate, wrapped)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.liveUpdate, wrapped)
    }
  },
  onDesktopUpdate: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => listener(snapshot)
    ipcRenderer.on(IPC_CHANNELS.desktopUpdate, wrapped)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.desktopUpdate, wrapped)
    }
  },
  onDesktopData: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, chunk: DesktopTerminalChunk) => listener(chunk)
    ipcRenderer.on(IPC_CHANNELS.desktopData, wrapped)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.desktopData, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('hubApi', hubApi)
