// IPC handlers for app configuration (electron-store).
//
// Commands (ipcMain.handle):
//   config:get    — returns the value for a single config key
//   config:set    — sets a single config key, after checking the value is one the key can hold
//   config:getAll — returns the full AppConfig object

import { ipcMain } from 'electron'
import { isAbsolute } from 'path'
import type Store from 'electron-store'
import { DEFAULT_STORAGE_PATH } from '@shared/constants'
import { wasPicked } from '../system/pickedFolders'
import type { AppConfig, RaidDifficulty, StatsSite, VideoCodec, WowRegion } from '@shared/ipc.types'

// The most a custom bitrate can be (Settings offers up to 100 Mbps)
const MAX_BITRATE_KBPS = 100_000
const MIN_BITRATE_KBPS = 500
// A window title or a path; anything longer isn't one
const MAX_STRING_LENGTH = 1024

const VIDEO_CODECS: readonly VideoCodec[] = ['h264', 'hevc']
const STATS_SITES: readonly StatsSite[] = ['raiderio', 'warcraftlogs', 'armory']
const WOW_REGIONS: readonly WowRegion[] = ['eu', 'us']
const RAID_DIFFICULTIES: readonly RaidDifficulty[] = ['lfr', 'normal', 'heroic', 'mythic']

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
  wowRegion: true,
  raidDifficulties: true,
  bufferWhileGameOpen: true
}

export function isConfigKey(key: unknown): key is keyof AppConfig {
  return typeof key === 'string' && Object.hasOwn(CONFIG_KEYS, key)
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && !value.includes('\0')
}

function isAbsolutePath(value: unknown): value is string {
  return isShortString(value) && value.length > 0 && isAbsolute(value)
}

function isOneOf<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T)
}

function isPositiveNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

// Whether value is something the setting can hold. Paths must be absolute, choices must be
// one of the app's options, and numbers must be in the range the capture helper and the
// cleanup accept. The page only ever sends such values; this keeps a bug (or anything
// else running in the page) from writing one the main process would then act on.
export function isValidConfigValue<K extends keyof AppConfig>(key: K, value: unknown): value is AppConfig[K] {
  switch (key) {
    case 'wowPath':
    case 'storagePath':
      return isAbsolutePath(value)
    case 'captureSourceHint':
      return isShortString(value)
    case 'videoBitrate':
      return Number.isInteger(value) && (value as number) >= MIN_BITRATE_KBPS && (value as number) <= MAX_BITRATE_KBPS
    case 'videoFps':
      return value === 30 || value === 60
    case 'videoCodec':
      return isOneOf(VIDEO_CODECS, value)
    case 'videoResolution':
      return isShortString(value) && /^(native|[1-9]\d{2,3}x[1-9]\d{2,3})$/.test(value)
    case 'autoCleanupDays':
    case 'autoCleanupMaxGb':
      return isPositiveNumberOrNull(value)
    case 'minimizeToTray':
    case 'onboardingComplete':
    case 'bufferWhileGameOpen':
      return typeof value === 'boolean'
    case 'statsSite':
      return isOneOf(STATS_SITES, value)
    case 'wowRegion':
      return isOneOf(WOW_REGIONS, value)
    case 'raidDifficulties':
      return Array.isArray(value) && value.every((d) => isOneOf(RAID_DIFFICULTIES, d)) && new Set(value).size === value.length
    default:
      return false
  }
}

export function registerConfigIpc(configStore: Store<AppConfig>): void {
  ipcMain.handle('config:get', (_event, { key }: { key: string }) => {
    if (!isConfigKey(key)) return undefined
    return configStore.get(key)
  })

  ipcMain.handle('config:set', (_event, { key, value }: { key: string; value: unknown }) => {
    if (!isConfigKey(key)) throw new Error(`Unknown setting: ${String(key)}`)
    if (!isValidConfigValue(key, value)) throw new Error(`Not a valid value for ${key}: ${JSON.stringify(value) ?? String(value)}`)
    // The recordings folder is what app://depleted/media may serve from, so it only moves
    // to a folder the user picked (or back to the default)
    if (key === 'storagePath' && value !== configStore.get('storagePath') && value !== DEFAULT_STORAGE_PATH && !wasPicked(value as string)) {
      throw new Error('The recordings folder can only be changed to a folder chosen in the folder picker')
    }
    configStore.set(key, value)
  })

  ipcMain.handle('config:getAll', () => {
    return configStore.store
  })
}
