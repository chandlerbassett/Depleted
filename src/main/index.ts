import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
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
import { registerLogAnalysisIpc } from './ipc/logAnalysis.ipc'
import { registerTestModeIpc } from './ipc/testMode.ipc'

import { CombatLogWatcher } from './combatlog/CombatLogWatcher'
import { WindowCaptureRecorder } from './recorder/WindowCaptureRecorder'
import { NativeCaptureRecorder } from './recorder/NativeCaptureRecorder'
import type { CaptureRecorder } from './recorder/CaptureRecorder'
import { nativeHelperPath } from './recorder/nativeHelperPath'
import { RecorderStateMachine } from './recorder/RecorderStateMachine'
import type { ProcessingRequiredEvent } from './recorder/RecorderStateMachine'
import { MythicPlusStateMachine } from './recorder/MythicPlusStateMachine'
import { StorageManager, ffmpegMediaTools, nativeMediaTools, type MediaTools } from './storage/StorageManager'
import { readAddonCharacterInfo } from './addon/SavedVarsReader'
import { resolveFfmpegPath } from './system/ffmpeg'

import type { AppConfig } from '@shared/ipc.types'
import {
  COMBAT_LOG_RELATIVE_DIR,
  COMBAT_LOG_GLOB,
  DEFAULT_STORAGE_PATH,
  DEFAULT_VIDEO_BITRATE_KBPS,
  DEFAULT_VIDEO_FPS,
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
  defaults: {
    wowPath: DEFAULT_WOW_PATH,
    storagePath: DEFAULT_STORAGE_PATH,
    videoBitrate: DEFAULT_VIDEO_BITRATE_KBPS,
    videoFps: DEFAULT_VIDEO_FPS,
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

// ---------------------------------------------------------------------------
// Pipeline singletons — created once, shared across IPC registrations
// ---------------------------------------------------------------------------

function createPipeline(): {
  watcher: CombatLogWatcher
  recorder: CaptureRecorder
  stateMachine: RecorderStateMachine
  mythicPlusMachine: MythicPlusStateMachine
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
  const localPlayer = readAddonCharacterInfo(wowPath)
  const recorderOptions = {
    bitrateKbps: configStore.get('videoBitrate'),
    fps: configStore.get('videoFps'),
    sourceHint: configStore.get('captureSourceHint'),
    resolution: configStore.get('videoResolution')
  }
  const stateMachine = new RecorderStateMachine(watcher, recorder, {
    rawRecordingsDir: rawDir,
    localPlayerName: localPlayer?.fullName ?? null,
    localPlayerGuid: localPlayer?.guid ?? null,
    recorder: recorderOptions
  })
  const mythicPlusMachine = new MythicPlusStateMachine(watcher, recorder, {
    rawRecordingsDir: rawDir,
    recorder: recorderOptions
  })
  const storageManager = new StorageManager(storagePath)

  // Post-processing is the same for arena matches and Mythic+ keys
  const onProcessingRequired = (event: ProcessingRequiredEvent): void => {
    let media: MediaTools
    try {
      media = useNative ? nativeMediaTools(nativeHelperPath()) : ffmpegMediaTools(resolveFfmpegPath())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Main] Cannot post-process recording:', message)
      return
    }

    storageManager
      .processRecording(event, media, event.timeline)
      .then((recording) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('storage:recordingProcessed', { recording })
          }
        }
      })
      .catch((err: Error) => {
        console.error('[Main] Post-processing failed:', err.message)
      })
  }
  stateMachine.on('processingRequired', onProcessingRequired)
  mythicPlusMachine.on('processingRequired', onProcessingRequired)

  watcher.start()
  console.warn(`[Main] Combat log watcher started: ${logsDir}/${COMBAT_LOG_GLOB}`)

  return { watcher, recorder, stateMachine, mythicPlusMachine, storageManager }
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

function createWindow(
  stateMachine: RecorderStateMachine,
  mythicPlusMachine: MythicPlusStateMachine,
  storageManager: StorageManager
): BrowserWindow {
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
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
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Wire per-window push events (ipcMain.handle is registered once at startup)
  wireRecorderWindow([stateMachine, mythicPlusMachine], mainWindow)
  wireStorageWindow(storageManager, mainWindow)
  wireAddonWindow(configStore, mainWindow, stateMachine)

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

app.whenReady().then(() => {
  registerSystemIpc(configStore)
  registerConfigIpc(configStore)
  registerLogAnalysisIpc(configStore)

  const { recorder, stateMachine, mythicPlusMachine, storageManager } = createPipeline()

  // Keep recorder options in sync with config changes (e.g. window selection in Settings).
  const recorderConfigKeys = ['videoBitrate', 'videoFps', 'captureSourceHint', 'videoResolution'] as const
  for (const key of recorderConfigKeys) {
    configStore.onDidChange(key, () => {
      const opts = {
        bitrateKbps: configStore.get('videoBitrate'),
        fps: configStore.get('videoFps'),
        sourceHint: configStore.get('captureSourceHint'),
        resolution: configStore.get('videoResolution')
      }
      stateMachine.updateRecorderOptions(opts)
      mythicPlusMachine.updateRecorderOptions(opts)
    })
  }

  // Register ipcMain.handle commands once — re-registration throws in Electron.
  registerRecorderIpc([stateMachine, mythicPlusMachine])
  registerStorageIpc(storageManager)
  registerTestModeIpc(recorder, stateMachine, configStore, configStore.get('storagePath'))

  const mainWindow = createWindow(stateMachine, mythicPlusMachine, storageManager)

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
      createWindow(stateMachine, mythicPlusMachine, storageManager)
    } else {
      wins[0]?.show()
    }
  })

  // Stop any active capture before quitting so macOS releases the screen recording
  // indicator immediately and the hidden capture window/write stream are torn down
  // cleanly (mainWindow stays open throughout, so window-all-closed doesn't fire
  // prematurely while the hidden window is being destroyed).
  app.on('before-quit', (event) => {
    isQuitting = true
    if (!recorder.isRecording()) return
    event.preventDefault()
    recorder
      .stop()
      .catch((err: Error) => console.error('[Main] Failed to stop recorder on quit:', err.message))
      .finally(() => app.quit())
  })
})

// Quit on window close on all platforms — this is a utility app, not a menu-bar app.
app.on('window-all-closed', () => {
  app.quit()
})
