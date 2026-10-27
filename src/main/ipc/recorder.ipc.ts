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
import type { RecorderStatus } from '@shared/ipc.types'
import type { RecorderStateMachine } from '../recorder/RecorderStateMachine'
import type { MythicPlusStateMachine } from '../recorder/MythicPlusStateMachine'

// Arena and Mythic+ each have their own state machine; the renderer sees one status.
type AnyStateMachine = RecorderStateMachine | MythicPlusStateMachine

// The busy machine wins — at most one is ever out of idle at a time.
function combinedStatus(stateMachines: AnyStateMachine[]): RecorderStatus {
  return stateMachines.map((m) => m.getStatus()).find((s) => s !== 'idle') ?? 'idle'
}

// Register ipcMain.handle commands — call ONCE at app startup.
export function registerRecorderIpc(stateMachines: AnyStateMachine[]): void {
  ipcMain.handle('recorder:getStatus', () => {
    return combinedStatus(stateMachines)
  })
}

// Wire push events (main → renderer) to a specific BrowserWindow.
// Call once per created window (including re-created windows on macOS activate).
export function wireRecorderWindow(
  stateMachines: AnyStateMachine[],
  mainWindow: BrowserWindow
): void {
  for (const stateMachine of stateMachines) {
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
}
