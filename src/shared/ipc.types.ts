// All IPC channel names and payload types for the application.
// Main process: ipcMain.handle / webContents.send
// Renderer: ipcRenderer.invoke / ipcRenderer.on (via contextBridge)

import type { CoachData } from './coach.types'
import type { BenchmarkResult } from './benchmark.types'

// ---------------------------------------------------------------------------
// Bracket and result types
// ---------------------------------------------------------------------------

// Depleted records Mythic+ keys only. Recordings from the arena era (other brackets)
// may still be on disk; StorageManager skips them.
export type RecordingBracket = 'mythic-plus'
// WIN = key completed, LOSS = depleted or abandoned (MythicPlusInfo.outcome has the detail)
export type RecordingResult = 'WIN' | 'LOSS'

export type RecorderStatus = 'idle' | 'waiting' | 'recording' | 'processing' | 'error'

// ---------------------------------------------------------------------------
// Timeline event types (stored in metadata.json and used in renderer)
// ---------------------------------------------------------------------------

export type TimelineEventType =
  | 'death-player'
  | 'interrupt'
  | 'key-start'
  | 'key-end'
  | 'boss-kill'
  | 'boss-wipe'

export interface DeathHit {
  spellId?: number
  spellName: string
  amount: number
  relSecs: number  // seconds before death (0 = at death moment, negative = before)
  // HP% of the target just before this hit landed (requires Advanced Combat Logging)
  hpPct?: number
  casterName?: string
  isCritical?: boolean
}

// A CC or defensive/trinket cast in the run-up to a death (no damage amount).
export interface DeathCastEvent {
  spellId?: number
  spellName: string
  relSecs: number  // seconds before death (0 = at death moment, negative = before)
  casterName?: string  // set for CC applied by someone else; omitted for own defensives
}

export interface TimelineEvent {
  timestamp: number // seconds from recording start
  type: TimelineEventType
  spellId?: number
  spellName?: string
  duration?: number     // actual CC duration in seconds (AURA_APPLIED → AURA_REMOVED)
  unit?: string         // unit name for death events
  casterName?: string   // who cast the spell
  targetName?: string   // who was targeted
  target?: 'player' | 'enemy'
  deathSummary?: DeathHit[]  // last 10 seconds of incoming damage (death events only)
  deathHealing?: DeathHit[]  // last 10 seconds of healing received (death events only)
  deathCCTaken?: DeathCastEvent[]  // CC applied to the dying player in the last 10 seconds
  deathDefensivesUsed?: DeathCastEvent[]  // defensives/trinket the dying player used in the last 10 seconds
  // Interrupt-specific: undefined = unknown, true = interrupted a spell, false = hit on immune (Precognition)
  isSuccessful?: boolean
  // Name of the spell that was interrupted (successful interrupts only)
  interruptedSpell?: string
  // Caster's HP% at the moment of cast (defensive-type events only; requires Advanced
  // Combat Logging — undefined when no recent UNIT_HEALTH sample is available).
  casterHpPct?: number
}

// ---------------------------------------------------------------------------
// Recording metadata (written to metadata.json, read back by storage layer)
// ---------------------------------------------------------------------------

export interface RecordingMetadata {
  date: string // ISO 8601
  zone: string
  bracket: RecordingBracket
  result: RecordingResult
  duration: number // seconds
  // Video container extension without the dot, e.g. "mp4" or "webm" — depends on which
  // MediaRecorder mimeType WindowCaptureRecorder negotiated (mp4 preferred, webm
  // fallback). Missing on recordings made before this field existed — treat as "mp4".
  videoExt?: string
  playerName: string    // local player fullName (Name-Realm), empty if addon not connected
  playerClass: string
  playerSpec: string
  // Party roster
  teamComp: string[]
  // name → spec string
  knownSpecs: Record<string, string>
  // Per-player meters (Details!/Skada-style bar charts) — name → total for the key
  playerDamageDone?: Record<string, number>
  playerDamageTaken?: Record<string, number>
  playerHealingDone?: Record<string, number>
  mythicPlus: MythicPlusInfo
  events: TimelineEvent[]
}

export type MythicPlusOutcome = 'completed' | 'depleted' | 'abandoned'

export interface MythicPlusEncounter {
  encounterId: number
  name: string
  start: number // seconds from recording start
  end: number   // seconds from recording start
  success: boolean
}

export interface MythicPlusInfo {
  instanceId: number
  challengeModeId: number
  keystoneLevel: number
  affixIds: number[]
  // 'completed' = CHALLENGE_MODE_END success flag set. Whether that flag means "in time"
  // or just "finished" still needs confirming against a real log.
  outcome: MythicPlusOutcome
  // Key timer from CHALLENGE_MODE_END (ms), 0 if the key never ended cleanly
  totalTimeMs: number
  // From CHALLENGE_MODE_END: this dungeon's score and the overall M+ rating after the key.
  // The log has no "before" value. null when the key never ended or was reset.
  score: { dungeon: number; overall: number } | null
  encounters: MythicPlusEncounter[]
  deathCount: number
  // name → number of deaths during the key
  deathsByPlayer: Record<string, number>
  // name → successful interrupts during the key
  interruptsByPlayer: Record<string, number>
}

export interface Recording {
  id: string // directory name
  path: string // absolute path to directory
  videoPath: string
  thumbnailPath: string
  metadata: RecordingMetadata
}

// ---------------------------------------------------------------------------
// Command channels: ipcMain.handle / ipcRenderer.invoke (request/response)
// ---------------------------------------------------------------------------

export interface IpcCommands {
  // Recorder control
  'recorder:start': { params: void; result: void }
  'recorder:stop': { params: void; result: void }
  'recorder:getStatus': { params: void; result: RecorderStatus }

  // Storage
  'storage:getRecordings': { params: void; result: Recording[] }
  'storage:deleteRecording': { params: { id: string }; result: void }
  'storage:openFolder': { params: { id: string }; result: void }
  'storage:getCoachData': { params: { id: string }; result: CoachData | null }

  // Coach: comparing with top Warcraft Logs players. The secret never comes back.
  'coach:getWclStatus': { params: void; result: { configured: boolean; clientId: string | null } }
  'coach:setWclCredentials': {
    params: { clientId: string; clientSecret: string }
    result: { ok: boolean; error?: string }
  }
  'coach:clearWclCredentials': { params: void; result: void }
  'coach:getBenchmark': { params: { specId: number; dungeon: string; keyLevel: number }; result: BenchmarkResult }

  // Config
  'config:get': { params: { key: string }; result: unknown }
  'config:set': { params: { key: string; value: unknown }; result: void }
  'config:getAll': { params: void; result: AppConfig }

  // Addon connection status
  'system:getAddonStatus': {
    params: void
    // needsUpdate: the installed addon predates MIN_ADDON_VERSION (or never reported a
    // version) — the UI should prompt the user to reinstall it via system:installAddon.
    result: { connected: boolean; name?: string; spec?: string; className?: string; needsUpdate?: boolean }
  }

  // System / onboarding checks
  'system:checkBrew': { params: void; result: { found: boolean; path: string | null } }
  'system:checkFfmpeg': { params: void; result: { found: boolean; path: string | null } }
  'system:checkScreenPermission': {
    params: void
    result: { status: 'granted' | 'denied' | 'not-determined' }
  }
  'system:requestScreenPermission': {
    params: void
    result: { status: 'granted' | 'denied' | 'not-determined' }
  }
  'system:checkAddon': { params: { wowPath: string }; result: { found: boolean } }
  'system:installAddon': { params: { wowPath: string }; result: { success: boolean; error?: string } }
  'system:openAddonSource': { params: void; result: void }
  'system:openAddonsDir': { params: { wowPath: string }; result: void }
  'system:listCaptureWindows': { params: void; result: CaptureSource[] }
  'system:checkWowPath': { params: { path: string }; result: { valid: boolean } }
  'system:openSystemPreferences': { params: void; result: void }
  'system:pickFolder': { params: void; result: { path: string | null } }
  'system:openUrl': { params: { url: string }; result: { success: boolean; error?: string } }
  'system:relaunch': { params: void; result: void }
  'system:getPlatform': { params: void; result: { platform: string } }

  // Test mode — records a short clip of the capture source so the user can verify
  // the app will work before running a key.
  // Rejects if a key is already being recorded (stateMachine not idle).
  'testMode:start': { params: void; result: { success: boolean; error?: string; videoPath?: string } }
  // Deletes the last test recording's file + containing directory.
  'testMode:cleanup': { params: void; result: void }
}

// ---------------------------------------------------------------------------
// Push event channels: webContents.send / ipcRenderer.on (main → renderer)
// ---------------------------------------------------------------------------

export interface IpcEvents {
  'recorder:statusChanged': { status: RecorderStatus; zone?: string }
  'recorder:error': { message: string }
  // Fired after a recording is successfully post-processed
  'storage:recordingProcessed': { recording: Recording }
  // Fired on startup when orphaned recording directories are found
  'storage:orphanedRecordings': { paths: string[] }
  // Fired when the SavedVariables file changes — addon character switched
  'addon:statusChanged': { connected: boolean; name?: string; spec?: string; className?: string; needsUpdate?: boolean }
  // Fired once per second while a test-mode recording is running, counting down to 0
  'testMode:countdown': { secondsRemaining: number }
}

// External character-stats site opened when a player name is clicked in a recording.
export type StatsSite = 'raiderio' | 'warcraftlogs' | 'armory'

// WoW region — used to resolve a character's realm when the combat log name has no
// region suffix (same-region names log as "Name-Realm", not "Name-Realm-EU").
export type WowRegion = 'eu' | 'us'

// Video codec for native macOS capture (hardware encoded via VideoToolbox).
export type VideoCodec = 'h264' | 'hevc'

// ---------------------------------------------------------------------------
// App configuration stored in electron-store
// ---------------------------------------------------------------------------

export interface AppConfig {
  wowPath: string
  storagePath: string
  videoBitrate: number // kbps
  videoFps: 30 | 60
  videoCodec: VideoCodec
  // desktopCapturer source name to capture, or 'auto' to auto-detect the WoW window
  // by title. Persisted by name (not source id — ids aren't stable across restarts).
  captureSourceHint: string
  videoResolution: string // "3840x2160" | "native" | "2560x1440" | "1920x1080" | "1280x720"
  autoCleanupDays: number | null // null = disabled
  autoCleanupMaxGb: number | null // null = disabled
  minimizeToTray: boolean
  onboardingComplete: boolean
  statsSite: StatsSite
  wowRegion: WowRegion
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'window' | 'screen'
  thumbnailDataUrl?: string
  // true if the name matches "World of Warcraft" (exact or substring) — used to badge
  // the auto-detected source in the Settings picker.
  isLikelyWow: boolean
}

// ---------------------------------------------------------------------------
// Preload API exposed to renderer via contextBridge
// ---------------------------------------------------------------------------

export interface ElectronAPI {
  invoke<K extends keyof IpcCommands>(
    channel: K,
    params?: IpcCommands[K]['params']
  ): Promise<IpcCommands[K]['result']>

  on<K extends keyof IpcEvents>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void // returns unsubscribe function
}
