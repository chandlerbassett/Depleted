// All IPC channel names and payload types for the application.
// Main process: ipcMain.handle / webContents.send
// Renderer: ipcRenderer.invoke / ipcRenderer.on (via contextBridge)

// ---------------------------------------------------------------------------
// Bracket and result types
// ---------------------------------------------------------------------------

export type ArenaBracket = '2v2' | '3v3' | 'solo-shuffle' | 'skirmish'
// Everything a recording can be: an arena bracket, or a Mythic+ key.
export type RecordingBracket = ArenaBracket | 'mythic-plus'
export type ArenaResult = 'WIN' | 'LOSS'

export type RecorderStatus = 'idle' | 'waiting' | 'recording' | 'processing' | 'error'

// ---------------------------------------------------------------------------
// Timeline event types (stored in metadata.json and used in renderer)
// ---------------------------------------------------------------------------

export type TimelineEventType =
  | 'arena-start'
  | 'arena-end'
  | 'death-player'
  | 'death-enemy'
  | 'cc'
  | 'defensive'
  | 'offensive'
  | 'interrupt'
  | 'cc-break'
  | 'trinket'
  // Mythic+ only
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
  isHealerCC?: boolean  // CC whose target is a confirmed healer
  unusedDefensives?: string[]  // defensives that were off cooldown at time of death (local player only)
  isMistake?: boolean   // flagged as a mistake (e.g. DR-immune CC, bad interrupt)
  mistakeReason?: string // human-readable reason, e.g. "DR immune", "Bad interrupt"
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

export type MistakeSeverity = 'HIGH' | 'MEDIUM' | 'LOW'

// A single post-match mistake finding (see src/main/analysis/mistakeDetector.ts).
export interface DetectedMistake {
  id: string
  severity: MistakeSeverity
  title: string
  tip: string
  timestamp: number
  spellId?: number
  spellName?: string
  targetName?: string
  // Name of the player this mistake is "about" — i.e. who should learn from it (usually
  // the caster who committed the mistake), used to power the Mistakes panel's per-player
  // filter. Distinct from targetName, which is whoever/whatever was affected by the cast
  // (an enemy CC'd into immunity, a healer left free, etc.) and isn't always the same
  // person as the one who made the mistake.
  player?: string
}

// ---------------------------------------------------------------------------
// Recording metadata (written to metadata.json, read back by storage layer)
// ---------------------------------------------------------------------------

export interface RecordingMetadata {
  date: string // ISO 8601
  zone: string
  bracket: RecordingBracket
  result: ArenaResult
  duration: number // seconds
  // Video container extension without the dot, e.g. "mp4" or "webm" — depends on which
  // MediaRecorder mimeType WindowCaptureRecorder negotiated (mp4 preferred, webm
  // fallback). Missing on recordings made before this field existed — treat as "mp4".
  videoExt?: string
  playerName: string    // local player fullName (Name-Realm), empty if addon not connected
  playerClass: string
  playerSpec: string
  teamComp: string[]
  enemyComp: string[]
  // name → spec string derived from COMBATANT_INFO specId (populated at match start)
  knownSpecs: Record<string, string>
  // names of confirmed healers (from SPELL_HEAL cross-heals + specId)
  healerNames: string[]
  rating: { before: number; after: number } | null
  // name → personal rating from COMBATANT_INFO (populated at match start)
  playerRatings?: Record<string, number>
  // name → total damage absorbed by shields this player cast (SPELL_ABSORBED)
  playerAbsorb?: Record<string, number>
  // Per-player meters (Details!/Skada-style bar charts) — name → total for the match/round
  playerDamageDone?: Record<string, number>
  playerDamageTaken?: Record<string, number>
  playerHealingDone?: Record<string, number>
  // Post-match mistake analysis (see src/main/analysis/mistakeDetector.ts)
  mistakes?: DetectedMistake[]
  // Per-second cumulative damage for line charts (index = second from match start)
  teamDmgBySecond?: number[]
  enemyDmgBySecond?: number[]
  teamHealBySecond?: number[]
  enemyHealBySecond?: number[]
  // Solo Shuffle only
  round?: number
  sessionId?: string
  // Mythic+ only
  mythicPlus?: MythicPlusInfo
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
// Log analysis types
// ---------------------------------------------------------------------------

export interface ArenaPlayerStats {
  guid: string
  name: string
  team: number        // 0 = local player's team, 1 = enemy team
  ratingBefore: number
  ratingAfter: number
  isHealer: boolean
  className: string   // inferred from spell events, empty if no tracked spells observed
  specName: string    // inferred from spec-unique spell events, empty if undetermined
}

export interface MatchAnalysisSummary {
  playerDeaths: number
  enemyDeaths: number
  ccCount: number
  interruptCount: number
  defensiveCount: number
  offensiveCount: number
  ccBreakCount: number
}

export interface MatchAnalysis {
  id: string
  bracket: ArenaBracket
  zone: string
  result: ArenaResult
  duration: number
  date: string
  playerName: string
  ratingBefore?: number
  ratingAfter?: number
  round?: number
  sessionId?: string
  events: TimelineEvent[]
  summary: MatchAnalysisSummary
  playerTeam: ArenaPlayerStats[]
  enemyTeam: ArenaPlayerStats[]
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

  // Config
  'config:get': { params: { key: string }; result: unknown }
  'config:set': { params: { key: string; value: unknown }; result: void }
  'config:getAll': { params: void; result: AppConfig }

  // Log file analysis
  'logAnalysis:parseFile': { params: { filePath: string }; result: MatchAnalysis[] }
  'logAnalysis:getCache': { params: void; result: { filePath: string; matches: MatchAnalysis[] } | null }

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
  'system:pickLogFile': { params: void; result: { path: string | null } }
  'system:openUrl': { params: { url: string }; result: { success: boolean; error?: string } }
  'system:relaunch': { params: void; result: void }
  'system:getPlatform': { params: void; result: { platform: string } }

  // Test mode — records a short clip of the capture source so the user can verify
  // the app will work before an actual match, without needing a full arena game.
  // Rejects if a real match recording is already in progress (stateMachine not idle).
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
  'combatlog:arenaDetected': { zone: string; bracket: ArenaBracket }
  // Fired after a recording is successfully post-processed
  'storage:recordingProcessed': { recording: Recording }
  // Fired on startup when orphaned recording directories are found
  'storage:orphanedRecordings': { paths: string[] }
  // Fired when the SavedVariables file changes — addon character switched
  'addon:statusChanged': { connected: boolean; name?: string; spec?: string; className?: string; needsUpdate?: boolean }
  // Fired once per second while a test-mode recording is running, counting down to 0
  'testMode:countdown': { secondsRemaining: number }
}

// External character-stats site used for the "view my stats" links in the Team panel
// and the My PVP Hub "Your Characters" list.
export type StatsSite = 'arenacoach' | 'seramate' | 'checkpvp' | 'drustvar' | 'armory'

// WoW region — used to resolve a character's realm when the combat log name has no
// region suffix (same-region names log as "Name-Realm", not "Name-Realm-EU").
export type WowRegion = 'eu' | 'us'

// ---------------------------------------------------------------------------
// App configuration stored in electron-store
// ---------------------------------------------------------------------------

export interface AppConfig {
  wowPath: string
  storagePath: string
  videoBitrate: number // kbps
  videoFps: 30 | 60
  // desktopCapturer source name to capture, or 'auto' to auto-detect the WoW window
  // by title. Persisted by name (not source id — ids aren't stable across restarts).
  captureSourceHint: string
  videoResolution: string // "native" | "2560x1440" | "1920x1080" | "1280x720"
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
