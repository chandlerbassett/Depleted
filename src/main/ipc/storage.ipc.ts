// IPC handlers for storage commands.
//
// Commands (ipcMain.handle):
//   storage:getRecordings    — returns all Recording[] sorted newest first
//   storage:deleteRecording  — asks first, then moves a recording directory to the Trash
//   storage:openFolder       — opens a recording directory in Finder
//   storage:getCoachData     — a recording's coach.json, or null
//   storage:saveClip         : cuts part of a recording into its clips/ folder
//   storage:deleteClip       : asks first, then moves a clip to the Trash
//   storage:showClip         : shows a clip in Finder
//
// Push events (webContents.send — fired from index.ts):
//   storage:recordingProcessed   — new recording is ready
//   storage:orphanedRecordings   — incomplete recordings found on startup

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { MediaTools, StorageManager } from '../storage/StorageManager'
import type { Recording } from '@shared/ipc.types'
import { RAID_DIFFICULTY_LABEL } from '@shared/constants'

// Register ipcMain.handle commands — call ONCE at app startup.
export function registerStorageIpc(storageManager: StorageManager, mediaTools: () => MediaTools | null): void {
  ipcMain.handle('storage:saveClip', async (_event, params: { id: string; start: number; end: number }) => {
    const media = mediaTools()
    if (media === null) throw new Error('The video tools are missing, so clips cannot be cut')
    return storageManager.saveClip(params.id, params.start, params.end, media)
  })

  ipcMain.handle('storage:deleteClip', async (event, params: { id: string }) => {
    const clip = await storageManager.getClip(params.id)
    if (clip === null) return { deleted: false }
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      message: 'Delete this clip?',
      detail: 'It will be moved to the Trash. The full recording is kept.',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = window === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options)
    if (response !== 0) return { deleted: false }
    await storageManager.deleteClip(clip.id, (path) => shell.trashItem(path))
    return { deleted: true }
  })

  ipcMain.handle('storage:showClip', async (_event, params: { id: string }) => {
    const clip = await storageManager.getClip(params.id)
    if (clip !== null) shell.showItemInFolder(clip.videoPath)
  })

  ipcMain.handle('storage:getRecordings', async () => {
    return storageManager.getRecordings()
  })

  // One misclick shouldn't cost a whole key: confirm on a sheet (Cancel is the default
  // button, so Return doesn't delete), then move it to the Trash so it can be put back.
  ipcMain.handle('storage:deleteRecording', async (event, params: { id: string }) => {
    const recordings = await storageManager.getRecordings()
    const recording = recordings.find((r) => r.id === params.id)
    // Only ever a run in the library, never some other folder in the storage path
    if (recording === undefined) return { deleted: false }
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      message: 'Delete this run?',
      detail: `${describeRun(recording)} and its Coach notes will be moved to the Trash.`,
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    }
    const { response } = window === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options)
    if (response !== 0) return { deleted: false }
    await storageManager.deleteRecording(recording.id, (dirPath) => shell.trashItem(dirPath))
    return { deleted: true }
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

// "Ruby Life Pools +15 from Oct 27, 2026", "Heroic Dimensius pull 3 from Oct 27, 2026"
export function describeRun(recording: Recording): string {
  const { zone, date, mythicPlus, raid } = recording.metadata
  const day = new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (raid !== undefined) {
    const pull = raid.pullNumber > 0 ? ` pull ${raid.pullNumber}` : ''
    return `${RAID_DIFFICULTY_LABEL[raid.difficulty]} ${raid.encounterName}${pull} from ${day}`
  }
  const level = mythicPlus !== undefined && mythicPlus.keystoneLevel > 0 ? ` +${mythicPlus.keystoneLevel}` : ''
  return `${zone || 'This run'}${level} from ${day}`
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
