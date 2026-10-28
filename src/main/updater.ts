// Auto-update from GitHub Releases (electron-updater reads latest-mac.yml on the latest
// release). Updates download in the background; Squirrel.Mac only installs one signed
// with the same Developer ID as the running app. The update is applied when the user
// clicks "Restart to update" (never while recording) or on the next quit.

import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function setupAutoUpdater(window: BrowserWindow, isRecording: () => boolean): void {
  // The version of an update that has finished downloading, if any
  let readyVersion: string | null = null

  ipcMain.handle('updater:getReady', (): { version: string | null } => ({ version: readyVersion }))
  ipcMain.handle('updater:install', (): { installed: boolean } => {
    if (readyVersion === null || isRecording()) return { installed: false }
    autoUpdater.quitAndInstall()
    return { installed: true }
  })

  // Dev builds have no app-update.yml, and unsigned builds can't install updates
  if (!app.isPackaged) return

  // Into main.log: checks, what was found, downloads
  autoUpdater.logger = {
    info: (message?: unknown) => console.warn('[Updater]', message),
    warn: (message?: unknown) => console.warn('[Updater]', message),
    error: (message?: unknown) => console.error('[Updater]', message)
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version
    if (!window.isDestroyed()) window.webContents.send('updater:ready', { version: info.version })
  })
  // Offline or GitHub unreachable: try again at the next check. The logger above has
  // already written the error to main.log.
  autoUpdater.on('error', () => undefined)

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}
