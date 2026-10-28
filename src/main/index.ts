import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { chmodSync, readdirSync } from 'fs'
import Store from 'electron-store'

// On macOS, Electron's getDisplayMedia({ audio: 'loopback' }) has historically returned
// a real audio TRACK whose buffer is silence — the track "exists" (so naive audio-track
// presence checks pass) but no actual system audio ever comes through. These two
// Chromium flags turn on the real ScreenCaptureKit-backed loopback path; must be set
// before app 'ready' fires, which is why this sits above every other import's side
// effects. macOS-only: the flags are meaningless (and Chromium ignores unknown
// features) on Windows, where WASAPI loopback via 'loopback' already works without them.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
}

import { registerSystemIpc, wireAddonWindow } from './ipc/system.ipc'
import { registerRecorderIpc, wireRecorderWindow } from './ipc/recorder.ipc'
import { registerStorageIpc, wireStorageWindow } from './ipc/storage.ipc'
import { registerConfigIpc } from './ipc/config.ipc'
import { registerTestModeIpc } from './ipc/testMode.ipc'
import { registerCoachIpc } from './ipc/coach.ipc'

import { CombatLogWatcher } from './combatlog/CombatLogWatcher'
import { WindowCaptureRecorder } from './recorder/WindowCaptureRecorder'
import { NativeCaptureRecorder } from './recorder/NativeCaptureRecorder'
import type { CaptureRecorder } from './recorder/CaptureRecorder'
import { nativeHelperPath } from './recorder/nativeHelperPath'
import { MythicPlusStateMachine } from './recorder/MythicPlusStateMachine'
import { setupAutoUpdater } from './updater'
import type { ProcessingRequiredEvent } from './recorder/types'
import { StorageManager, ffmpegMediaTools, nativeMediaTools, type MediaTools } from './storage/StorageManager'
import { resolveFfmpegPath } from './system/ffmpeg'
import { openExternalUrl } from './system/openExternal'

import type { AppConfig, Recording } from '@shared/ipc.types'
import {
  COMBAT_LOG_RELATIVE_DIR,
  COMBAT_LOG_GLOB,
  DEFAULT_STORAGE_PATH,
  DEFAULT_VIDEO_BITRATE_KBPS,
  DEFAULT_VIDEO_FPS,
  DEFAULT_VIDEO_CODEC,
  DEFAULT_CAPTURE_SOURCE_HINT,
  DEFAULT_VIDEO_RESOLUTION,
  DEFAULT_MINIMIZE_TO_TRAY,
  DEFAULT_STATS_SITE,
  DEFAULT_WOW_REGION
} from '@shared/constants'

// ---------------------------------------------------------------------------
// App config — electron-store with typed defaults
// ---------------------------------------------------------------------------

const DEFAULT_WOW_PATH = process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\World of Warcraft'
  : '/Applications/World of Warcraft'

const configStore = new Store<AppConfig>({
  // Only this user: electron-store otherwise writes it world-readable and writable
  configFileMode: 0o600,
  defaults: {
    wowPath: DEFAULT_WOW_PATH,
    storagePath: DEFAULT_STORAGE_PATH,
    videoBitrate: DEFAULT_VIDEO_BITRATE_KBPS,
    videoFps: DEFAULT_VIDEO_FPS,
    videoCodec: DEFAULT_VIDEO_CODEC,
    captureSourceHint: DEFAULT_CAPTURE_SOURCE_HINT,
    videoResolution: DEFAULT_VIDEO_RESOLUTION,
    autoCleanupDays: null,
    autoCleanupMaxGb: null,
    minimizeToTray: DEFAULT_MINIMIZE_TO_TRAY,
    onboardingComplete: false,
    statsSite: DEFAULT_STATS_SITE,
    wowRegion: DEFAULT_WOW_REGION
  }
})
// configFileMode only applies when the file is next written; fix older installs now
try {
  chmodSync(configStore.path, 0o600)
} catch {
  // Not written yet
}


// Recordings being trimmed and saved — quitting waits for them
const pendingSaves = new Set<Promise<unknown>>()

function trackSave(save: Promise<unknown>): void {
  pendingSaves.add(save)
  void save.finally(() => pendingSaves.delete(save))
}

function listRawRecordings(rawDir: string): string[] {
  try {
    return readdirSync(rawDir)
      .filter((name) => name.startsWith('raw_mplus_') && /\.(mp4|webm)$/.test(name))
      .map((name) => join(rawDir, name))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Pipeline singletons — created once, shared across IPC registrations
// ---------------------------------------------------------------------------

function createPipeline(): {
  watcher: CombatLogWatcher
  recorder: CaptureRecorder
  stateMachine: MythicPlusStateMachine
  storageManager: StorageManager
} {
  const wowPath = configStore.get('wowPath')
  const storagePath = configStore.get('storagePath')
  const logsDir = join(wowPath, COMBAT_LOG_RELATIVE_DIR)
  const rawDir = join(storagePath, 'raw')

  const watcher = new CombatLogWatcher({ dir: logsDir, glob: COMBAT_LOG_GLOB })
  // macOS records, trims and thumbnails with the native helper (ScreenCaptureKit +
  // hardware encode); other platforms keep the Chromium MediaRecorder + FFmpeg path.
  const useNative = process.platform === 'darwin'
  const recorder: CaptureRecorder = useNative ? new NativeCaptureRecorder(nativeHelperPath) : new WindowCaptureRecorder()
  const recorderOptions = {
    bitrateKbps: configStore.get('videoBitrate'),
    fps: configStore.get('videoFps'),
    codec: configStore.get('videoCodec'),
    sourceHint: configStore.get('captureSourceHint'),
    resolution: configStore.get('videoResolution')
  }
  const stateMachine = new MythicPlusStateMachine(watcher, recorder, {
    rawRecordingsDir: rawDir,
    recorder: recorderOptions
  })
  const storageManager = new StorageManager(storagePath)

  const mediaTools = (): MediaTools | null => {
    try {
      return useNative ? nativeMediaTools(nativeHelperPath()) : ffmpegMediaTools(resolveFfmpegPath())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Main] Cannot post-process recording:', message)
      return null
    }
  }
  const announce = (recording: Recording): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('storage:recordingProcessed', { recording })
      }
    }
  }

  stateMachine.on('processingRequired', (event: ProcessingRequiredEvent): void => {
    const media = mediaTools()
    if (media === null) return
    trackSave(
      storageManager
        .processRecording(event, media, event.timeline)
        .then(announce)
        .catch((err: Error) => {
          console.error('[Main] Post-processing failed:', err.message)
        })
    )
  })

  // Raw files already there were left by a crash or force-quit: nothing records into
  // raw/ until the watcher starts, so list them first, then save them as abandoned keys.
  const leftoverRaw = listRawRecordings(rawDir)
  if (leftoverRaw.length > 0) {
    const media = mediaTools()
    if (media !== null) {
      trackSave(
        storageManager
          .recoverRawRecordings(leftoverRaw, media)
          .then((recovered) => recovered.forEach(announce))
      )
    }
  }

  watcher.start()
  console.warn(`[Main] Combat log watcher started: ${logsDir}/${COMBAT_LOG_GLOB}`)

  return { watcher, recorder, stateMachine, storageManager }
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

let tray: Tray | null = null
// Set to true when the app is actually quitting so the window close event
// doesn't intercept and hide the window instead of letting it close.
let isQuitting = false

async function createTray(mainWindow: BrowserWindow): Promise<void> {
  if (tray !== null) return
  tray = new Tray(await trayIcon())
  tray.setToolTip('Depleted')
  tray.on('double-click', () => mainWindow.show())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))
}

// macOS gets a monochrome template image (the "Template" suffix makes it follow the
// light/dark menu bar, and the @2x file is picked up automatically). Elsewhere, and if
// it's missing, fall back to the executable's icon, which in dev is Electron's logo.
async function trayIcon(): Promise<Electron.NativeImage> {
  if (process.platform === 'darwin') {
    const dir = app.isPackaged ? join(process.resourcesPath, 'tray') : join(app.getAppPath(), 'resources', 'tray')
    const image = nativeImage.createFromPath(join(dir, 'trayTemplate.png'))
    if (!image.isEmpty()) return image
  }
  try {
    return await app.getFileIcon(process.execPath, { size: 'small' })
  } catch {
    return nativeImage.createEmpty()
  }
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(stateMachine: MythicPlusStateMachine, storageManager: StorageManager): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The packaged page is a file:// page, so it can show recordings (file:// too)
      // with web security on. The dev server's http page can't, so it's off there only.
      webSecurity: !process.env.ELECTRON_RENDERER_URL
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting && configStore.get('minimizeToTray')) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url).catch((err: Error) => console.warn('[Main] Link not opened:', err.message))
    return { action: 'deny' }
  })
  // The window only ever shows the app itself
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  // Wire per-window push events (ipcMain.handle is registered once at startup)
  wireRecorderWindow(stateMachine, mainWindow)
  wireStorageWindow(storageManager, mainWindow)
  wireAddonWindow(configStore, mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// One copy at a time: a second one would watch the same combat log and record the
// same key. Opening the app again brings the running one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(startApp)
}

function startApp(): void {
  registerSystemIpc(configStore)
  registerConfigIpc(configStore)

  const { recorder, stateMachine, storageManager } = createPipeline()

  // Keep recorder options in sync with config changes (e.g. window selection in Settings).
  const recorderConfigKeys = ['videoBitrate', 'videoFps', 'videoCodec', 'captureSourceHint', 'videoResolution'] as const
  for (const key of recorderConfigKeys) {
    configStore.onDidChange(key, () => {
      const opts = {
        bitrateKbps: configStore.get('videoBitrate'),
        fps: configStore.get('videoFps'),
        codec: configStore.get('videoCodec'),
        sourceHint: configStore.get('captureSourceHint'),
        resolution: configStore.get('videoResolution')
      }
      stateMachine.updateRecorderOptions(opts)
    })
  }

  // Register ipcMain.handle commands once — re-registration throws in Electron.
  registerRecorderIpc(stateMachine)
  registerStorageIpc(storageManager)
  registerCoachIpc(storageManager)
  registerTestModeIpc(recorder, stateMachine, configStore, configStore.get('storagePath'))

  const mainWindow = createWindow(stateMachine, storageManager)
  setupAutoUpdater(mainWindow, () => recorder.isRecording())

  // Create tray on startup if the setting is enabled, and react to changes.
  if (configStore.get('minimizeToTray')) {
    void createTray(mainWindow)
  }
  configStore.onDidChange('minimizeToTray', (enabled) => {
    if (enabled) {
      void createTray(mainWindow)
    } else {
      destroyTray()
    }
  })

  app.on('activate', () => {
    // On macOS: clicking the dock icon shows the window even if it was hidden to tray.
    const wins = BrowserWindow.getAllWindows()
    if (wins.length === 0) {
      createWindow(stateMachine, storageManager)
    } else {
      wins[0]?.show()
    }
  })

  // Stop any active capture before quitting so macOS releases the screen recording
  // indicator immediately and the hidden capture window/write stream are torn down
  // cleanly (mainWindow stays open throughout, so window-all-closed doesn't fire
  // prematurely while the hidden window is being destroyed). A key still running is
  // saved as abandoned, and quitting waits for recordings that are still being saved,
  // so nothing is left behind in raw/.
  let quitCleanupDone = false
  app.on('before-quit', (event) => {
    isQuitting = true
    if (quitCleanupDone || (!recorder.isRecording() && pendingSaves.size === 0)) return
    event.preventDefault()
    quitCleanupDone = true
    stateMachine
      .finishForQuit()
      .then(async () => {
        // Test mode
        if (recorder.isRecording()) await recorder.stop()
      })
      .then(() => Promise.allSettled([...pendingSaves]))
      .catch((err: Error) => console.error('[Main] Failed to stop recorder on quit:', err.message))
      .finally(() => app.quit())
  })
}

// Quit on window close on all platforms — this is a utility app, not a menu-bar app.
app.on('window-all-closed', () => {
  app.quit()
})
