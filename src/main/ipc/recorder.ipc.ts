// IPC handlers for recorder status and push events.
//
// Commands (ipcMain.handle):
//   recorder:getStatus  — returns current RecorderStatus
//
// Push events (webContents.send — main → renderer):
//   recorder:statusChanged  — fired on every state transition
//   recorder:error          — fired when the state machine enters error state

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { MythicPlusStateMachine } from '../recorder/MythicPlusStateMachine'

// Register ipcMain.handle commands — call ONCE at app startup.
export function registerRecorderIpc(stateMachine: MythicPlusStateMachine): void {
  ipcMain.handle('recorder:getStatus', () => stateMachine.getStatus())
}

// Wire push events (main → renderer) to a specific BrowserWindow.
// Call once per created window (including re-created windows on macOS activate).
export function wireRecorderWindow(stateMachine: MythicPlusStateMachine, mainWindow: BrowserWindow): void {
  stateMachine.on('statusChanged', (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recorder:statusChanged', payload)
    }
  })

  stateMachine.on('error', (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recorder:error', payload)
    }
  })
}
