// IPC handlers for app configuration (electron-store).
//
// Commands (ipcMain.handle):
//   config:get    — returns the value for a single config key
//   config:set    — sets a single config key
//   config:getAll — returns the full AppConfig object

import { ipcMain } from 'electron'
import type Store from 'electron-store'
import type { AppConfig } from '@shared/ipc.types'

// Settings the page can change: every AppConfig key (the compiler checks the list is
// complete). electron-store reads dots in a key as a path, so anything else is refused.
const CONFIG_KEYS: Readonly<Record<keyof AppConfig, true>> = {
  wowPath: true,
  storagePath: true,
  videoBitrate: true,
  videoFps: true,
  videoCodec: true,
  captureSourceHint: true,
  videoResolution: true,
  autoCleanupDays: true,
  autoCleanupMaxGb: true,
  minimizeToTray: true,
  onboardingComplete: true,
  statsSite: true,
  wowRegion: true
}

export function isConfigKey(key: unknown): key is keyof AppConfig {
  return typeof key === 'string' && Object.hasOwn(CONFIG_KEYS, key)
}

export function registerConfigIpc(configStore: Store<AppConfig>): void {
  ipcMain.handle('config:get', (_event, { key }: { key: string }) => {
    if (!isConfigKey(key)) return undefined
    return configStore.get(key)
  })

  ipcMain.handle('config:set', (_event, { key, value }: { key: string; value: unknown }) => {
    if (!isConfigKey(key)) throw new Error(`Unknown setting: ${String(key)}`)
    configStore.set(key, value as AppConfig[keyof AppConfig])
  })

  ipcMain.handle('config:getAll', () => {
    return configStore.store
  })
}
