// IPC handlers for storage commands.
//
// Commands (ipcMain.handle):
//   storage:getRecordings    — returns all Recording[] sorted newest first
//   storage:deleteRecording  — deletes a recording directory by id
//   storage:openFolder       — opens a recording directory in Finder
//   storage:getCoachData     — a recording's coach.json, or null
//
// Push events (webContents.send — fired from index.ts):
//   storage:recordingProcessed   — new recording is ready
//   storage:orphanedRecordings   — incomplete recordings found on startup

import { ipcMain, shell } from 'electron'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import type { StorageManager } from '../storage/StorageManager'

// Register ipcMain.handle commands — call ONCE at app startup.
export function registerStorageIpc(storageManager: StorageManager): void {
  ipcMain.handle('storage:getRecordings', async () => {
    return storageManager.getRecordings()
  })

  ipcMain.handle('storage:deleteRecording', async (_event, params: { id: string }) => {
    await storageManager.deleteRecording(params.id)
  })

  ipcMain.handle('storage:getCoachData', async (_event, params: { id: string }) => {
    return storageManager.getCoachData(params.id)
  })

  ipcMain.handle('storage:openFolder', async (_event, params: { id: string }) => {
    const recordings = await storageManager.getRecordings()
    const recording = recordings.find((r) => r.id === params.id)
    if (recording === undefined) return
    shell.showItemInFolder(join(recording.path, 'recording.mp4'))
  })
}

// Wire push events (main → renderer) to a specific BrowserWindow.
// Call once per created window (including re-created windows on macOS activate).
export function wireStorageWindow(
  storageManager: StorageManager,
  mainWindow: BrowserWindow
): void {
  // Push orphaned recordings to renderer once the window is ready
  storageManager
    .findOrphanedRecordings()
    .then((paths) => {
      if (paths.length > 0 && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('storage:orphanedRecordings', { paths })
      }
    })
    .catch((err: Error) => {
      console.warn('[StorageIpc] findOrphanedRecordings failed:', err.message)
    })
}
