import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI, IpcEvents } from '@shared/ipc.types'
import { isCommandChannel, isEventChannel } from '@shared/ipcChannels'

// Only the app's own channels get through: a page can't reach any other ipcMain handler
// (or listen to any other event) through this bridge, whatever runs in it.
const api: ElectronAPI = {
  invoke(channel, params) {
    if (!isCommandChannel(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`))
    return ipcRenderer.invoke(channel, params)
  },

  on(channel, listener) {
    if (!isEventChannel(channel)) throw new Error(`Unknown IPC event: ${String(channel)}`)
    const handler = (_event: Electron.IpcRendererEvent, payload: IpcEvents[typeof channel]) => {
      listener(payload)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

contextBridge.exposeInMainWorld('electron', api)

// Extend the window type in renderer — declared in src/renderer/src/env.d.ts
