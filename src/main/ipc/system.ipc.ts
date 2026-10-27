// IPC handlers for system / onboarding checks.
// Channels: system:checkFfmpeg, system:checkScreenPermission, system:checkAddon,
//           system:checkWowPath, system:openSystemPreferences, system:pickFolder

import { ipcMain, shell, dialog, app, desktopCapturer, type BrowserWindow } from 'electron'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { cp, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import type Store from 'electron-store'
import { resolveFfmpegPath, checkScreenPermission as checkScreenPermissionSync } from '../system/ffmpeg'
import { listCaptureSources } from '../recorder/sourceResolver'
import { readAddonCharacterInfo, isAddonInfoStale, isAddonVersionOutdated } from '../addon/SavedVarsReader'
import { isInstalledAddonOutdated } from '../addon/addonVersionCheck'
import { ADDON_NAME, ADDON_RELATIVE_PATH, COMBAT_LOG_RELATIVE_PATH } from '@shared/constants'
import type { AppConfig, CaptureSource } from '@shared/ipc.types'
// Where the addon bundled with this build lives — packaged builds ship it under
// resourcesPath; in dev it's just the repo's addon/ folder (electron-builder hasn't run).
export function resolveBundledAddonDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'addon') : join(app.getAppPath(), 'addon')
}

export function registerSystemIpc(configStore: Store<AppConfig>): void {
  // Return the current process platform so renderer can adapt onboarding flow.
  ipcMain.handle('system:getPlatform', (): { platform: string } => {
    return { platform: process.platform }
  })

  // Check whether Homebrew is installed and return its path.
  // On Windows, Homebrew doesn't exist — return found:true as a no-op so the
  // onboarding brew step auto-passes and the FFmpeg check runs immediately.
  ipcMain.handle('system:checkBrew', (): { found: boolean; path: string | null } => {
    if (process.platform === 'win32') return { found: true, path: null }

    try {
      const p = execSync('which brew', { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString()
        .trim()
      if (p.length > 0) return { found: true, path: p }
    } catch {
      // Fall through to known Homebrew locations.
    }

    const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { found: true, path: candidate }
    }

    return { found: false, path: null }
  })

  // Check whether FFmpeg is installed and return its path.
  ipcMain.handle('system:checkFfmpeg', (): { found: boolean; path: string | null } => {
    try {
      const path = resolveFfmpegPath()
      return { found: true, path }
    } catch {
      return { found: false, path: null }
    }
  })

  // Check Screen Recording permission status. On Windows, always granted (no permission model).
  ipcMain.handle(
    'system:checkScreenPermission',
    async (): Promise<{ status: 'granted' | 'denied' | 'not-determined' }> => {
      if (process.platform === 'win32') return { status: 'granted' }
      // getMediaAccessStatus('screen') is unreliable on macOS 15 Sequoia — it can
      // return 'denied' even when the user has granted permission. Use
      // desktopCapturer.getSources as the authoritative check: if it returns at
      // least one source the app can actually capture the screen.
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (sources.length > 0) return { status: 'granted' }
      } catch {
        // Falls through to getMediaAccessStatus below
      }
      const raw = checkScreenPermissionSync()
      const status = raw === 'restricted' ? 'denied' : raw
      return { status }
    }
  )

  // Trigger the macOS screen recording permission prompt. No-op on Windows.
  ipcMain.handle(
    'system:requestScreenPermission',
    async (): Promise<{ status: 'granted' | 'denied' | 'not-determined' }> => {
      if (process.platform === 'win32') return { status: 'granted' }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (sources.length > 0) return { status: 'granted' }
      } catch {
        // Throws when permission is denied — expected
      }
      const raw = checkScreenPermissionSync()
      const status = raw === 'restricted' ? 'denied' : raw
      return { status }
    }
  )

  // Check whether SimpleCombatLogger is installed in the given WoW path.
  ipcMain.handle(
    'system:checkAddon',
    (_event, { wowPath }: { wowPath: string }): { found: boolean } => {
      const addonPath = join(wowPath, ADDON_RELATIVE_PATH)
      return { found: existsSync(addonPath) }
    }
  )

  // Validate a candidate WoW installation path by checking for the Logs directory.
  ipcMain.handle(
    'system:checkWowPath',
    (_event, { path }: { path: string }): { valid: boolean } => {
      const logsDir = join(path, '_retail_', 'Logs')
      return { valid: existsSync(logsDir) }
    }
  )

  // Open the Screen Recording section of macOS System Settings. No-op on Windows.
  ipcMain.handle('system:openSystemPreferences', (): void => {
    if (process.platform !== 'win32') {
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
    }
  })

  // Show a native folder picker dialog and return the selected path.
  ipcMain.handle('system:pickFolder', async (): Promise<{ path: string | null }> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return { path: canceled || filePaths.length === 0 ? null : (filePaths[0] ?? null) }
  })

  // List window/screen capture sources for the Settings manual-override picker.
  // Auto-detection (WoW window by title) happens separately in sourceResolver.ts at
  // recording-start time — this handler is only for populating the picker UI.
  ipcMain.handle('system:listCaptureWindows', async (): Promise<CaptureSource[]> => {
    return listCaptureSources()
  })

  // Copy the bundled DepletedCompanion addon to the WoW AddOns directory.
  ipcMain.handle(
    'system:installAddon',
    async (_event, { wowPath }: { wowPath: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        const src = join(resolveBundledAddonDir(), ADDON_NAME)
        const dest = join(wowPath, ADDON_RELATIVE_PATH)
        await mkdir(dirname(dest), { recursive: true })
        await cp(src, dest, { recursive: true })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // Open the bundled addon source folder in Finder/Explorer for manual copying.
  ipcMain.handle('system:openAddonSource', (): void => {
    void shell.openPath(resolveBundledAddonDir())
  })

  // Open the WoW AddOns directory in Finder/Explorer for manual copying.
  ipcMain.handle('system:openAddonsDir', async (_event, { wowPath }: { wowPath: string }): Promise<void> => {
    const addonsDir = join(wowPath, '_retail_', 'Interface', 'AddOns')
    await mkdir(addonsDir, { recursive: true }).catch(() => {})
    void shell.openPath(addonsDir)
  })

  // Return addon connection status by reading the SavedVariables file.
  ipcMain.handle('system:getAddonStatus', () => {
    const wowPath = configStore.get('wowPath')
    const info = readAddonCharacterInfo(wowPath)
    // Two independent signals, OR'd together: the SavedVariables `version` field (only
    // known once the addon has actually run and written it) and a direct .toc-vs-.toc
    // comparison against the file sitting in the AddOns folder right now (works even if
    // WoW hasn't been launched this session — see addonVersionCheck.ts).
    const needsUpdate =
      (info !== null && isAddonVersionOutdated(info)) || isInstalledAddonOutdated(wowPath, resolveBundledAddonDir())
    if (info === null) return { connected: false, needsUpdate }
    if (isAddonInfoStale(info)) return { connected: false, needsUpdate }
    return { connected: true, name: info.name, spec: info.spec, className: info.class, needsUpdate }
  })

  // Open a URL in the user's default browser. Reports success/failure — shell.openExternal
  // can reject (unregistered protocol handler, sandboxing, etc.) and callers otherwise
  // have no way to tell "opened invisibly in the background" apart from "silently did
  // nothing", which reads identically to the user.
  ipcMain.handle(
    'system:openUrl',
    async (_event, { url }: { url: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        await shell.openExternal(url)
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // Relaunch the app — used after path settings changes that require a restart.
  ipcMain.handle('system:relaunch', (): void => {
    app.relaunch()
    app.exit(0)
  })
}

// Re-export for convenience so index.ts can import from one place.
export { COMBAT_LOG_RELATIVE_PATH }

// ---------------------------------------------------------------------------
// Addon SavedVars file watcher — pushes addon:statusChanged to the window
// whenever WoW flushes SavedVariables to disk (on character switch/reload/exit,
// which is also when the addon prints "loaded" to chat on PLAYER_LOGIN).
//
// WoW only WRITES this file on /reload, logout, or a clean exit — it is not polled.
// Staleness (e.g. "quit the game 3 days ago and never reloaded since") is instead
// detected from the `updated` timestamp the addon itself writes into SavedVariables on
// every login/zone-change/spec-change (see isAddonInfoStale) — no OS-level window
// polling needed.
// ---------------------------------------------------------------------------

let addonWatcher: FSWatcher | null = null

export function wireAddonWindow(
  configStore: Store<AppConfig>,
  win: BrowserWindow
): void {
  addonWatcher?.close().catch(() => {})

  const wowPath = configStore.get('wowPath')
  const pattern = join(
    wowPath,
    '_retail_',
    'WTF',
    'Account',
    '*',
    'SavedVariables',
    `${ADDON_NAME}.lua`
  ).replace(/\\/g, '/')

  function push(): void {
    const info = readAddonCharacterInfo(wowPath)
    if (win.isDestroyed()) return
    // OR the SavedVariables-reported version with a direct .toc-vs-.toc file comparison
    // — the latter also catches "addon needs updating" even when WoW hasn't been
    // launched yet this session, so this check runs as soon as the window is created,
    // not just after the player logs in.
    const needsUpdate =
      (info !== null && isAddonVersionOutdated(info)) || isInstalledAddonOutdated(wowPath, resolveBundledAddonDir())
    if (info === null) {
      win.webContents.send('addon:statusChanged', { connected: false, needsUpdate })
      return
    }
    const payload = isAddonInfoStale(info)
      ? { connected: false, needsUpdate }
      : { connected: true, name: info.name, spec: info.spec, className: info.class, needsUpdate }
    win.webContents.send('addon:statusChanged', payload)
  }

  addonWatcher = chokidar.watch(pattern, {
    persistent: false,
    usePolling: false,
    ignoreInitial: true,
  })
  addonWatcher.on('change', push)
  addonWatcher.on('add', push)

  // Push current status immediately so the renderer reflects saved-vars state on startup
  // without requiring a WoW /reload to trigger a file-change event.
  push()
}
