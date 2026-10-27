// Recording pipeline state machine: idle → waiting → recording → processing → idle.
//
// State transitions:
//   idle      → waiting    : arenaZoneEntered — recorder.start() is called here
//   waiting   → recording  : arenaMatchStart — match has begun
//   recording → processing : arenaMatchEnd / soloShuffleRoundEnd — recorder.stop()
//   processing → idle      : 2v2/3v3 — processing complete, await zone exit
//   processing → waiting   : Solo Shuffle — next round, recorder.start() again
//   any       → idle       : arenaZoneLeft — abort recording if active
//   any       → error      : recorder crashes or start/stop fails

import { EventEmitter } from 'events'
import { join } from 'path'
import type {
  ArenaBracket,
  ArenaResult,
  MythicPlusInfo,
  RecorderStatus,
  RecordingBracket,
  TimelineEvent
} from '@shared/ipc.types'
import {
  SPELL_CLASS_MAP,
  DR_CATEGORY,
  WOW_SPEC_ID_MAP,
  SPELL_IDS_CC,
  SPELL_IDS_DEFENSIVE,
  SPELL_IDS_IMMUNITY,
  LOW_VALUE_CC_IDS,
  DEATH_RECAP_WINDOW_SECS,
  SOLO_SHUFFLE_ROUNDS_PER_SESSION,
  SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS
} from '@shared/constants'
import { getClassDefensives, type WowClass } from '@shared/classAbilities'
import { detectMistakes, type AuraWindow, type DetectedMistake } from '../analysis/mistakeDetector'
import type { CombatLogWatcher } from '../combatlog/CombatLogWatcher'
import type { CaptureRecorder, RecorderOptions } from './CaptureRecorder'
import type {
  ArenaZoneEnteredEvent,
  ArenaMatchStartEvent,
  SpellCastEvent,
  SpellAuraEvent,
  UnitDiedEvent,
  HealerCastEvent,
  CombatantInfoEvent,
  SpellDamageEvent,
  SpellHealAmountEvent,
  SpellAbsorbEvent,
  ArenaMatchStatsEntryEvent,
  UnitHealthEvent,
  SpellInterruptSuccessEvent,
  PrecognitionGainedEvent
} from '../combatlog/CombatLogParser'
import { UNIT_FLAG_REACTION_HOSTILE } from '../combatlog/CombatLogParser'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateMachineOptions {
  // Directory for raw (untrimmed) recordings before post-processing
  rawRecordingsDir: string
  // Local player's fullName (Name-Realm) from addon SavedVars — used for "could use" filter.
  // null = unknown (show "could use" for no deaths, to avoid false positives).
  localPlayerName: string | null
  // Local player's GUID from addon SavedVars (e.g. "Player-1329-0A8E2A98") — the reliable
  // way to identify the local player in COMBATANT_INFO/guidTeams. Prefer this over
  // localPlayerName: the addon's stored name omits the realm's region suffix (e.g.
  // "Name-Realm" vs the combat log's "Name-Realm-EU"), which silently broke exact name
  // matching. null = unknown (addon not connected) — falls back to name matching, then
  // to the unreliable ARENA_MATCH_START field.
  localPlayerGuid: string | null
  // Options forwarded to recorder.start()
  recorder?: RecorderOptions
}

// Emitted when a match recording is complete and ready for post-processing.
// Stage 5 subscribes to this event and performs trim / thumbnail / metadata.
export interface ProcessingRequiredEvent {
  rawPath: string
  zoneName: string
  bracket: RecordingBracket
  // WIN/LOSS for arena; for Mythic+, WIN = key completed (see mythicPlus.outcome)
  result: ArenaResult
  durationSecs: number
  // Exact time the ARENA_MATCH_START event was received
  matchStartedAt: Date
  // Time recorder.start() was called — used to calculate the trim offset
  recordingStartedAt: Date
  // Timeline events collected during this match (relative timestamps in seconds)
  timeline: TimelineEvent[]
  // name → spec string from COMBATANT_INFO
  knownSpecs: Record<string, string>
  // confirmed healer names
  healerNames: string[]
  // Team rosters resolved from COMBATANT_INFO (session.guidTeams), NOT from the
  // per-event target/caster reaction-flag heuristic VideoPlayer.vue falls back to when
  // these are empty — that heuristic breaks for spells like Mind Control, which flips
  // the target's hostile/friendly flag for its duration, corrupting the guess. Empty
  // arrays here mean "couldn't resolve" (e.g. addon not connected) — the renderer falls
  // back to its heuristic in that case.
  teamComp: string[]
  enemyComp: string[]
  // name → personal rating from COMBATANT_INFO
  playerRatings: Record<string, number>
  // Shield-caster name → total damage absorbed by their shields (SPELL_ABSORBED)
  playerAbsorb: Record<string, number>
  // Per-player meters (Details!/Skada-style) — name → total for the match/round
  playerDamageDone: Record<string, number>
  playerDamageTaken: Record<string, number>
  playerHealingDone: Record<string, number>
  // Post-match mistake analysis (see src/main/analysis/mistakeDetector.ts)
  detectedMistakes: DetectedMistake[]
  // Per-second cumulative damage arrays for line charts
  teamDmgBySecond: number[]
  enemyDmgBySecond: number[]
  teamHealBySecond: number[]
  enemyHealBySecond: number[]
  // Local player's rating change for this match (from ARENA_MATCH_STATS)
  ratingBefore?: number
  ratingAfter?: number
  // Solo Shuffle only
  roundNumber?: number
  sessionId?: string
  // For multi-round sessions: how many processingRequired events share this rawPath.
  // StorageManager deletes the raw file only after all rounds have been processed.
  totalRoundsInSession?: number
  // Mythic+ only (MythicPlusStateMachine)
  mythicPlus?: MythicPlusInfo
}

export interface StateMachineEventMap {
  statusChanged: { status: RecorderStatus; zone?: string }
  error: { message: string }
  // Stage 5 hooks here to perform post-processing
  processingRequired: ProcessingRequiredEvent
}

// ---------------------------------------------------------------------------
// Internal session context
// ---------------------------------------------------------------------------

interface DrCounter {
  count: number       // number of applications since window opened
  windowExpiresAt: number  // relSecs when the 18s DR window expires (set on aura removal)
}

interface ActiveCC {
  spellId: number
  spellName: string
  startRelSecs: number
  // Index in pendingTimeline so we can back-fill the duration
  timelineIndex: number
}

interface DamageHit {
  relSecs: number
  spellId?: number
  spellName: string
  amount: number
  casterName?: string
  isCritical?: boolean
}

interface DmgSample {
  sec: number
  total: number
}

// Snapshot of one completed round's data, accumulated before the round is finalized.
interface CompletedRoundData {
  roundNumber: number
  matchStartedAt: Date
  durationSecs: number
  result: ArenaResult
  timeline: TimelineEvent[]
  knownSpecs: Record<string, string>
  healerNames: string[]
  playerRatings: Record<string, number>
  teamDmgBySecond: number[]
  enemyDmgBySecond: number[]
  teamHealBySecond: number[]
  enemyHealBySecond: number[]
  teamComp: string[]
  enemyComp: string[]
  playerAbsorb: Record<string, number>
  playerDamageDone: Record<string, number>
  playerDamageTaken: Record<string, number>
  playerHealingDone: Record<string, number>
  detectedMistakes: DetectedMistake[]
}

interface SessionContext {
  zoneId: number
  zoneName: string
  bracket: ArenaBracket | null
  isSoloShuffle: boolean
  roundNumber: number
  sessionId: string
  // Which WoW team slot the local player is on (0 or 1), from ARENA_MATCH_START field 3
  localTeam: number
  // Local player's rating from ARENA_MATCH_STATS (filled after match end)
  ratingBefore: number | null
  ratingAfter: number | null
  recordingStartedAt: Date
  matchStartedAt: Date | null
  rawOutputPath: string | null
  // Timer ID for Solo Shuffle session-end timeout (guards against missing ARENA_MATCH_END)
  soloShuffleTimeoutId: ReturnType<typeof setTimeout> | null
  // Set while endSoloShuffleRound is mid-flight for the final round's post-roll delay
  // (status stays 'recording' during that wait, so a second near-simultaneous death —
  // e.g. two teammates dying in the same GCD — would otherwise re-enter and race it).
  endingFinalRound: boolean
  // Timeline events accumulated during the current round (cleared on each ARENA_MATCH_START)
  pendingTimeline: TimelineEvent[]
  // Per-player defensive + trinket cooldown usage: playerName → (spellId → relSecs used).
  playerCooldowns: Map<string, Map<number, number>>
  // Active CC auras: `${targetGuid}:${spellId}` → ActiveCC (to compute actual duration)
  activeCCs: Map<string, ActiveCC>
  // DR state per target per category: `${targetGuid}:${drCategory}` → DrCounter
  drCounters: Map<string, DrCounter>
  // Confirmed healers (by casterGuid) — detected via SPELL_HEAL cross-heal events
  healerGuids: Set<string>
  // casterGuid → casterName for healer lookups
  healerNames: Map<string, string>
  // playerName → spec string from COMBATANT_INFO specId
  knownSpecs: Map<string, string>
  // Shield-caster playerName → total damage absorbed by their shields this round
  absorbDoneByName: Map<string, number>
  // Per-player meters (Details!/Skada-style), keyed by playerName, cleared per round.
  dmgDoneByName: Map<string, number>
  dmgTakenByName: Map<string, number>
  healDoneByName: Map<string, number>
  // targetGuid → aura windows (open when end === Infinity) for spells in
  // SPELL_IDS_DEFENSIVE / SPELL_IDS_IMMUNITY / LOW_VALUE_CC_IDS — used by the mistake
  // detector to correlate offensive/cc/trinket casts against what was active on the
  // target (or caster, for the trinket case) at that moment. Deliberately separate from
  // activeCCs, which stays CC-only (used by the "no healer CC'd" check).
  auraWindows: Map<string, AuraWindow[]>

  // --- Per-session (not cleared per round) ---
  // GUID → { specId, personalRating, team } — deferred COMBATANT_INFO resolution when name was unknown
  pendingCombatantByGuid: Map<string, { specId: number | null; personalRating: number; team: number }>
  // GUID → WoW team (0=enemy, 1=local player's team) from COMBATANT_INFO
  guidTeams: Map<string, number>
  // playerName → personal rating from COMBATANT_INFO
  playerRatings: Map<string, number>

  // --- Per-round damage/heal tracking (cleared on ARENA_MATCH_START) ---
  // Last DEATH_RECAP_WINDOW_SECS of incoming damage per target GUID for death recap
  recentDamageByGuid: Map<string, DamageHit[]>
  // Last DEATH_RECAP_WINDOW_SECS of incoming healing per target GUID for death recap
  recentHealingByGuid: Map<string, DamageHit[]>
  // Last DEATH_RECAP_WINDOW_SECS of HP snapshots per GUID for death recap HP% (Advanced Combat Logging)
  recentHealthByGuid: Map<string, Array<{ relSecs: number; hp: number; maxHp: number }>>
  // Pending interrupt correlations — keyed by casterGuid and targetGuid for back-filling
  // timeline events once SPELL_INTERRUPT (success) or Precognition (failure) resolves them.
  pendingInterruptByCaster: Map<string, { timelineIdx: number; targetGuid: string; relSecs: number }>
  pendingInterruptByTarget: Map<string, { timelineIdx: number; relSecs: number }>
  // Cumulative damage/heal samples per team for line charts
  teamDmgAccum: number
  enemyDmgAccum: number
  teamHealAccum: number
  enemyHealAccum: number
  teamDmgSamples: DmgSample[]
  enemyDmgSamples: DmgSample[]
  teamHealSamples: DmgSample[]
  enemyHealSamples: DmgSample[]

  // --- Solo Shuffle per-round accumulation ---
  // Real (non-unconscious) player deaths in the current round, used to derive round result.
  currentRoundRealDeaths: Array<{ isEnemy: boolean }>
  // Finalized per-round data; populated as each new ARENA_MATCH_START fires.
  completedRounds: CompletedRoundData[]
}

// ---------------------------------------------------------------------------
// RecorderStateMachine
// ---------------------------------------------------------------------------

export class RecorderStateMachine extends EventEmitter {
  private status: RecorderStatus = 'idle'
  private session: SessionContext | null = null

  // Inferred class per player name — persists for the duration of the arena session.
  private readonly playerClassInferred = new Map<string, WowClass>()

  // Local player's fullName from addon SavedVars (Name-Realm format). Mutable — see
  // updateLocalPlayer(): the addon's SavedVariables may not exist yet at app startup
  // (e.g. WoW hasn't been /reload'd since install), in which case this stays null for
  // the whole session unless updated once the addon actually writes its data, silently
  // breaking team resolution (falls back to the unreliable per-event heuristic) for
  // every match recorded before that point.
  private localPlayerName: string | null
  // Local player's GUID from addon SavedVars — preferred over localPlayerName (see
  // StateMachineOptions.localPlayerGuid doc comment for why name matching is fragile).
  private localPlayerGuid: string | null

  // Diagnostic cross-check (2v2/3v3 only): the previous rated match's local-player
  // rating snapshot + computed result, held until the next COMBATANT_INFO for that
  // guid arrives (next match's pre-match rating) so we can verify the sign of the
  // rating change matches the result we recorded. Logs a warning on mismatch —
  // does not correct already-written files. See onCombatantInfo/onMatchEnd.
  private pendingRatingCheck: { guid: string; ratingBefore: number; result: ArenaResult; label: string } | null = null
  // Local player's personal rating from this match's COMBATANT_INFO (captured for the
  // cross-check above). Reset on each new match start.
  private currentMatchLocalRating: number | null = null

  private readonly watcher: CombatLogWatcher
  private readonly recorder: CaptureRecorder
  private options: StateMachineOptions

  constructor(watcher: CombatLogWatcher, recorder: CaptureRecorder, options: StateMachineOptions) {
    super()
    this.watcher = watcher
    this.recorder = recorder
    this.options = options
    this.localPlayerName = options.localPlayerName ?? null
    this.localPlayerGuid = options.localPlayerGuid ?? null

    this.bindParserEvents()
    this.bindRecorderEvents()
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  getStatus(): RecorderStatus {
    return this.status
  }

  updateRecorderOptions(opts: RecorderOptions): void {
    this.options = { ...this.options, recorder: opts }
  }

  // Called whenever the addon's SavedVariables file changes (WoW /reload, character
  // switch, or first becomes available after app startup) — keeps team resolution
  // working for the rest of the session instead of being frozen at whatever the addon
  // reported (or didn't) when the app first launched.
  updateLocalPlayer(name: string | null, guid: string | null): void {
    this.localPlayerName = name
    this.localPlayerGuid = guid
  }

  // ---------------------------------------------------------------------------
  // Typed EventEmitter overrides
  // ---------------------------------------------------------------------------

  override emit<K extends keyof StateMachineEventMap>(
    event: K,
    payload: StateMachineEventMap[K]
  ): boolean {
    return super.emit(event, payload)
  }

  override on<K extends keyof StateMachineEventMap>(
    event: K,
    listener: (payload: StateMachineEventMap[K]) => void
  ): this {
    return super.on(event, listener)
  }

  override once<K extends keyof StateMachineEventMap>(
    event: K,
    listener: (payload: StateMachineEventMap[K]) => void
  ): this {
    return super.once(event, listener)
  }

  // ---------------------------------------------------------------------------
  // Parser event binding
  // ---------------------------------------------------------------------------

  private bindParserEvents(): void {
    this.watcher.onParser('arenaZoneEntered', (e) => this.onZoneEntered(e))
    this.watcher.onParser('arenaZoneLeft', () => this.onZoneLeft())
    this.watcher.onParser('arenaMatchStart', (e) => this.onMatchStart(e))
    this.watcher.onParser('arenaMatchEnd', (e) =>
      this.onMatchEnd(e.winningTeam, e.durationSecs, e.timestamp)
    )
    this.watcher.onParser('spellCast', (e) => this.onSpellCast(e))
    this.watcher.onParser('unitDied', (e) => this.onUnitDied(e))
    this.watcher.onParser('spellAuraApplied', (e) => this.onAuraApplied(e))
    this.watcher.onParser('spellAuraRemoved', (e) => this.onAuraRemoved(e))
    this.watcher.onParser('healerCast', (e) => this.onHealerCast(e))
    this.watcher.onParser('combatantInfo', (e) => this.onCombatantInfo(e))
    this.watcher.onParser('spellDamage', (e) => this.onSpellDamage(e))
    this.watcher.onParser('spellHealAmount', (e) => this.onSpellHealAmount(e))
    this.watcher.onParser('spellAbsorb', (e) => this.onSpellAbsorb(e))
    this.watcher.onParser('arenaMatchStatsEntry', (e) => this.onArenaMatchStats(e))
    this.watcher.onParser('unitHealth', (e) => this.onUnitHealth(e))
    this.watcher.onParser('spellInterruptSuccess', (e) => this.onSpellInterruptSuccess(e))
    this.watcher.onParser('precognitionGained', (e) => this.onPrecognitionGained(e))
  }

  private bindRecorderEvents(): void {
    this.recorder.on('unexpectedStop', ({ outputPath, stderrTail }) => {
      console.error(
        '[StateMachine] FFmpeg stopped unexpectedly.\n' + stderrTail.slice(-5).join('\n')
      )
      this.session = null
      this.transitionTo('error')
      this.emit('error', {
        message: `Recording stopped unexpectedly. Raw file: ${outputPath}`
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Zone entry / exit
  // ---------------------------------------------------------------------------

  private onZoneEntered(e: ArenaZoneEnteredEvent): void {
    if (this.status !== 'idle' && this.status !== 'error') {
      console.warn(`[StateMachine] arenaZoneEntered in state "${this.status}" — ignoring`)
      return
    }
    if (this.status === 'error') {
      // Auto-recover: a new arena zone clears the error state
      this.transitionTo('idle')
    }

    this.session = {
      zoneId: e.zoneId,
      zoneName: e.zoneName,
      bracket: null,
      isSoloShuffle: false,
      roundNumber: 0,
      sessionId: e.timestamp.toISOString(),
      localTeam: 0,
      ratingBefore: null,
      ratingAfter: null,
      recordingStartedAt: new Date(),
      matchStartedAt: null,
      rawOutputPath: null,
      soloShuffleTimeoutId: null,
      endingFinalRound: false,
      pendingTimeline: [],
      playerCooldowns: new Map(),
      activeCCs: new Map(),
      drCounters: new Map(),
      healerGuids: new Set(),
      healerNames: new Map(),
      knownSpecs: new Map(),
      absorbDoneByName: new Map(),
      dmgDoneByName: new Map(),
      dmgTakenByName: new Map(),
      healDoneByName: new Map(),
      auraWindows: new Map(),
      pendingCombatantByGuid: new Map(),
      guidTeams: new Map(),
      playerRatings: new Map(),
      recentDamageByGuid: new Map(),
      recentHealingByGuid: new Map(),
      recentHealthByGuid: new Map(),
      pendingInterruptByCaster: new Map(),
      pendingInterruptByTarget: new Map(),
      teamDmgAccum: 0, enemyDmgAccum: 0,
      teamHealAccum: 0, enemyHealAccum: 0,
      teamDmgSamples: [], enemyDmgSamples: [],
      teamHealSamples: [], enemyHealSamples: [],
      currentRoundRealDeaths: [],
      completedRounds: []
    }

    this.transitionTo('waiting', e.zoneName)
    void this.startRecorder()
  }

  private onZoneLeft(): void {
    if (this.status === 'idle' || this.status === 'error') return

    if (this.status === 'waiting' || this.status === 'recording') {
      console.warn(`[StateMachine] Zone left during "${this.status}" — aborting recording`)
      void this.abortRecorder()
    }

    this.session = null
    this.playerClassInferred.clear()
    this.transitionTo('idle')
  }

  // ---------------------------------------------------------------------------
  // Match start / end
  // ---------------------------------------------------------------------------

  private onMatchStart(e: ArenaMatchStartEvent): void {
    // Fallback: if ZONE_CHANGE was missed (file created after watcher started),
    // treat ARENA_MATCH_START itself as the zone-entry trigger.
    if ((this.status === 'idle' || this.status === 'error') && this.session === null) {
      console.warn(`[StateMachine] ARENA_MATCH_START in idle — recovering via match-start trigger`)
      this.session = {
        zoneId: e.instanceId,
        zoneName: e.zoneName,
        bracket: null,
        isSoloShuffle: false,
        roundNumber: 0,
        sessionId: e.timestamp.toISOString(),
        localTeam: 0,
        ratingBefore: null,
        ratingAfter: null,
        recordingStartedAt: new Date(),
        matchStartedAt: null,
        rawOutputPath: null,
        soloShuffleTimeoutId: null,
        endingFinalRound: false,
        pendingTimeline: [],
        playerCooldowns: new Map(),
        activeCCs: new Map(),
        drCounters: new Map(),
        healerGuids: new Set(),
        healerNames: new Map(),
        knownSpecs: new Map(),
        absorbDoneByName: new Map(),
        dmgDoneByName: new Map(),
        dmgTakenByName: new Map(),
        healDoneByName: new Map(),
        auraWindows: new Map(),
        pendingCombatantByGuid: new Map(),
        guidTeams: new Map(),
        playerRatings: new Map(),
        recentDamageByGuid: new Map(),
        recentHealingByGuid: new Map(),
        recentHealthByGuid: new Map(),
        pendingInterruptByCaster: new Map(),
        pendingInterruptByTarget: new Map(),
        teamDmgAccum: 0, enemyDmgAccum: 0,
        teamHealAccum: 0, enemyHealAccum: 0,
        teamDmgSamples: [], enemyDmgSamples: [],
        teamHealSamples: [], enemyHealSamples: [],
        currentRoundRealDeaths: [],
        completedRounds: []
      }
      this.transitionTo('waiting', e.zoneName)
      void this.startRecorder()
    }

    // Solo shuffle rounds 2-6: recorder was stopped on UNIT_DIED; start a fresh one here.
    // (If we somehow receive ARENA_MATCH_START while still recording — e.g. UNIT_DIED was
    // missed — fall through to the waiting-state handler below which is a no-op, letting
    // onMatchEnd's fallback handle the cleanup when ARENA_MATCH_END arrives.)
    if (this.status === 'recording' && this.session !== null && this.session.isSoloShuffle) {
      console.warn('[StateMachine] ARENA_MATCH_START while still recording in solo shuffle — UNIT_DIED was likely missed; ignoring')
      return
    }

    if (this.status !== 'waiting' || this.session === null) return

    this.session.bracket = e.bracket
    this.session.isSoloShuffle = e.bracket === 'solo-shuffle'
    this.session.localTeam = e.localTeam
    this.session.roundNumber++
    this.session.matchStartedAt = e.timestamp
    this.currentMatchLocalRating = null
    console.warn(
      `[StateMachine] localPlayerName: ${this.localPlayerName ?? 'null (addon not connected)'}, ` +
        `localPlayerGuid: ${this.localPlayerGuid ?? 'null (addon not connected)'}`
    )
    // Cancel any pending solo-shuffle timeout from a previous round
    if (this.session.soloShuffleTimeoutId !== null) {
      clearTimeout(this.session.soloShuffleTimeoutId)
      this.session.soloShuffleTimeoutId = null
    }
    // Clear per-round state: all timestamps are relative to this match start.
    this.session.pendingTimeline = []
    this.session.currentRoundRealDeaths = []
    this.session.playerCooldowns = new Map()
    this.session.activeCCs = new Map()
    this.session.drCounters = new Map()
    this.session.absorbDoneByName = new Map()
    this.session.dmgDoneByName = new Map()
    this.session.dmgTakenByName = new Map()
    this.session.healDoneByName = new Map()
    this.session.auraWindows = new Map()
    this.session.recentDamageByGuid = new Map()
    this.session.recentHealingByGuid = new Map()
    this.session.recentHealthByGuid = new Map()
    this.session.pendingInterruptByCaster = new Map()
    this.session.pendingInterruptByTarget = new Map()
    this.session.teamDmgAccum = 0; this.session.enemyDmgAccum = 0
    this.session.teamHealAccum = 0; this.session.enemyHealAccum = 0
    this.session.teamDmgSamples = []; this.session.enemyDmgSamples = []
    this.session.teamHealSamples = []; this.session.enemyHealSamples = []

    // Solo shuffle rounds 2-6: start a new recorder (previous was stopped on UNIT_DIED).
    // Round 1 recorder was already started in onZoneEntered.
    if (this.session.isSoloShuffle && this.session.roundNumber > 1) {
      void this.startRecorder()
    }

    this.transitionTo('recording', this.session.zoneName)
    console.warn(
      `[StateMachine] Match started: ${e.bracket} in ${e.zoneName} ` +
        `(round ${this.session.roundNumber})`
    )
  }

  // Resolves which team (0/1) the logging player is actually on, using COMBATANT_INFO
  // (guidTeams, keyed by GUID). This is reliable — verified against real combat logs,
  // where ARENA_MATCH_START's field-3 "localTeam" stays constant for an entire session
  // regardless of the player's true per-match team, while COMBATANT_INFO's team field
  // correctly varies match to match. Returns null if the addon isn't connected or the
  // player's GUID/name can't be resolved yet, in which case callers should fall back to
  // session.localTeam (unreliable but better than nothing).
  private resolveLocalTeam(): number | null {
    if (this.session === null) return null

    // Preferred: direct GUID lookup from the addon's SavedVars. Robust against name
    // mismatches — confirmed in practice that the addon's stored name omits the
    // realm's region suffix (e.g. "Name-Realm" vs the combat log's "Name-Realm-EU"),
    // which silently broke exact string matching below.
    if (this.localPlayerGuid !== null) {
      const team = this.session.guidTeams.get(this.localPlayerGuid)
      if (team !== undefined) return team
    }

    // Fallback: name matching via the parser's GUID→name cache (built from combat
    // events, independent of COMBATANT_INFO's own name field which can lag behind).
    if (this.localPlayerName !== null) {
      const lowerName = this.localPlayerName.toLowerCase()
      for (const [guid, team] of this.session.guidTeams) {
        const name = this.watcher.parser.nameCache.get(guid)
        if (name !== undefined && name.toLowerCase() === lowerName) {
          return team
        }
      }
    }

    return null
  }

  // Compares the previous rated match's recorded result against the sign of the
  // rating change now observed (this match's pre-match rating vs. the previous
  // match's pre-match rating). Logs a warning on disagreement — diagnostic only.
  private checkPendingRatingAgainstResult(newRating: number): void {
    const pending = this.pendingRatingCheck
    if (pending === null || this.localPlayerGuid === null || pending.guid !== this.localPlayerGuid) return
    this.pendingRatingCheck = null

    const delta = newRating - pending.ratingBefore
    if (delta === 0) return // e.g. rating floor/ceiling — inconclusive, skip
    const impliedResult: ArenaResult = delta > 0 ? 'WIN' : 'LOSS'

    if (impliedResult !== pending.result) {
      console.warn(
        `[StateMachine] Rating-delta cross-check MISMATCH for ${pending.label}: ` +
          `recorded result=${pending.result}, but rating went ${pending.ratingBefore} → ${newRating} ` +
          `(${delta > 0 ? '+' : ''}${delta}), implying ${impliedResult}.`
      )
    }
  }

  // Resolves team rosters from COMBATANT_INFO (session.guidTeams — the same reliable,
  // GUID-keyed data resolveLocalTeam() uses for WIN/LOSS), instead of guessing from
  // per-event target/caster reaction flags. Returns empty arrays if localTeam is
  // unresolved (e.g. addon not connected) — VideoPlayer.vue falls back to its
  // heuristic in that case, same as it always has.
  private buildTeamRosters(localTeam: number | null): { teamComp: string[]; enemyComp: string[] } {
    if (this.session === null || localTeam === null) return { teamComp: [], enemyComp: [] }
    const teamComp: string[] = []
    const enemyComp: string[] = []
    for (const [guid, team] of this.session.guidTeams) {
      const name = this.watcher.parser.nameCache.get(guid)
      if (name === undefined) continue
      if (team === localTeam) teamComp.push(name)
      else enemyComp.push(name)
    }
    return { teamComp, enemyComp }
  }

  // Nearest HP% sample at or before relSecs for the given unit — requires Advanced
  // Combat Logging (UNIT_HEALTH). Returns undefined if no sample is available yet.
  private lookupHpPct(guid: string, relSecs: number): number | undefined {
    if (this.session === null) return undefined
    const samples = this.session.recentHealthByGuid.get(guid)
    if (samples === undefined) return undefined
    let hpPct: number | undefined
    let closestDelta = Infinity
    for (const s of samples) {
      const delta = relSecs - s.relSecs
      if (delta >= 0 && delta < closestDelta && s.maxHp > 0) {
        closestDelta = delta
        hpPct = Math.round((s.hp / s.maxHp) * 100)
      }
    }
    return hpPct
  }

  // Resolves session.auraWindows (GUID-keyed) to player names via the parser's name
  // cache, for the mistake detector — which only deals in names, matching
  // TimelineEvent's casterName/targetName fields.
  private buildAuraWindowsByName(): Map<string, AuraWindow[]> {
    const byName = new Map<string, AuraWindow[]>()
    if (this.session === null) return byName
    for (const [guid, windows] of this.session.auraWindows) {
      const name = this.watcher.parser.nameCache.get(guid)
      if (name === undefined) continue
      byName.set(name, windows)
    }
    return byName
  }

  private onMatchEnd(winningTeam: number, durationSecs: number, matchEndTimestamp: Date): void {
    // The final round's post-roll delay (see endSoloShuffleRound /
    // SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS) can still be in flight when
    // ARENA_MATCH_END arrives — status is still 'recording' in that window. Don't race
    // it: endSoloShuffleRound owns the full stop/emit/cleanup for that round once its
    // delay elapses. Once it flips to 'waiting', fall through to the general branch
    // below instead (also covers a solo-shuffle session ending before round 6 for any
    // reason, which the old status-only check always handled).
    if (this.session?.isSoloShuffle && this.session.endingFinalRound && this.status === 'recording') {
      if (this.session.soloShuffleTimeoutId !== null) {
        clearTimeout(this.session.soloShuffleTimeoutId)
      }
      return
    }

    // Normal solo shuffle path: recorder was already stopped on the last UNIT_DIED and
    // processingRequired was emitted; just clean up the session and go idle.
    if (this.session?.isSoloShuffle && this.status === 'waiting') {
      if (this.session.soloShuffleTimeoutId !== null) {
        clearTimeout(this.session.soloShuffleTimeoutId)
      }
      this.session = null
      this.playerClassInferred.clear()
      this.transitionTo('idle')
      return
    }

    if (this.status !== 'recording' || this.session === null) return

    // Cancel any pending solo-shuffle timeout — we got the match end event
    if (this.session.soloShuffleTimeoutId !== null) {
      clearTimeout(this.session.soloShuffleTimeoutId)
      this.session.soloShuffleTimeoutId = null
    }

    const {
      zoneName,
      bracket,
      isSoloShuffle,
      sessionId,
      recordingStartedAt,
      matchStartedAt,
      rawOutputPath
    } = this.session

    if (bracket === null || matchStartedAt === null || rawOutputPath === null) {
      console.error('[StateMachine] onMatchEnd: incomplete session context — aborting')
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: 'Internal state error: match ended with missing context' })
      return
    }

    const resolvedLocalTeam = this.resolveLocalTeam()
    if (resolvedLocalTeam === null) {
      console.warn(
        '[StateMachine] onMatchEnd: could not resolve local team via COMBATANT_INFO — ' +
          'falling back to unreliable ARENA_MATCH_START field 3'
      )
    }
    const effectiveLocalTeam = resolvedLocalTeam ?? this.session.localTeam
    const result: ArenaResult = winningTeam === effectiveLocalTeam ? 'WIN' : 'LOSS'
    const { teamComp, enemyComp } = this.buildTeamRosters(resolvedLocalTeam)

    // Diagnostic rating-delta cross-check (2v2/3v3 only — solo shuffle's rating only
    // moves once for the whole 6-round session, not per round; skirmish is unrated).
    // Rating "after" this match isn't available synchronously in Midnight logs
    // (ARENA_MATCH_STATS never fires) — the only signal is the NEXT match's
    // COMBATANT_INFO for the same guid, handled in onCombatantInfo. This only logs a
    // mismatch warning; it does not correct already-written files.
    if (!isSoloShuffle && bracket !== 'skirmish' && this.localPlayerGuid !== null && this.currentMatchLocalRating !== null) {
      this.pendingRatingCheck = {
        guid: this.localPlayerGuid,
        ratingBefore: this.currentMatchLocalRating,
        result,
        label: `${bracket} in ${zoneName} at ${matchStartedAt.toISOString()}`
      }
    }

    // For solo shuffle: finalize the last round, then snapshot all per-round data before
    // stopping the recorder (session context is cleared after stop).
    let completedRounds: CompletedRoundData[] = []
    if (isSoloShuffle) {
      this.finalizeCurrentRound(matchEndTimestamp)
      completedRounds = [...this.session.completedRounds]
    }

    const timeline = [...this.session.pendingTimeline]
    const knownSpecs = Object.fromEntries(this.session.knownSpecs)
    const healerNames = [...this.session.healerNames.keys()]
    const playerRatings = Object.fromEntries(this.session.playerRatings)
    const playerAbsorb = Object.fromEntries(this.session.absorbDoneByName)
    const playerDamageDone = Object.fromEntries(this.session.dmgDoneByName)
    const playerDamageTaken = Object.fromEntries(this.session.dmgTakenByName)
    const playerHealingDone = Object.fromEntries(this.session.healDoneByName)
    const detectedMistakes = detectMistakes(timeline, this.buildAuraWindowsByName())
    // For non-shuffle, use the parser-supplied durationSecs (correct for 2v2/3v3).
    // For solo shuffle, per-round durations are computed from timestamps in finalizeCurrentRound.
    const teamDmgBySecond = buildChartBySecond(this.session.teamDmgSamples, durationSecs)
    const enemyDmgBySecond = buildChartBySecond(this.session.enemyDmgSamples, durationSecs)
    const teamHealBySecond = buildChartBySecond(this.session.teamHealSamples, durationSecs)
    const enemyHealBySecond = buildChartBySecond(this.session.enemyHealSamples, durationSecs)

    // recorder.stop() clears ffmpegProcess synchronously, so the next startRecorder()
    // call won't conflict even if FFmpeg hasn't fully exited yet.
    const stopPromise = this.recorder.stop()

    this.transitionTo('processing', zoneName)

    const ratingBefore = this.session?.ratingBefore ?? undefined
    const ratingAfter = this.session?.ratingAfter ?? undefined

    void stopPromise
      .then((finalPath) => {
        if (isSoloShuffle && completedRounds.length > 0) {
          // Emit one processingRequired per round, sharing the same raw file.
          // StorageManager deletes the raw file only after all rounds have been processed.
          const totalRounds = completedRounds.length
          for (const round of completedRounds) {
            this.emit('processingRequired', {
              rawPath: finalPath,
              zoneName,
              bracket,
              result: round.result,
              durationSecs: round.durationSecs,
              matchStartedAt: round.matchStartedAt,
              recordingStartedAt,
              timeline: round.timeline,
              knownSpecs: round.knownSpecs,
              healerNames: round.healerNames,
              teamComp: round.teamComp,
              enemyComp: round.enemyComp,
              playerRatings: round.playerRatings,
              playerAbsorb: round.playerAbsorb,
              playerDamageDone: round.playerDamageDone,
              playerDamageTaken: round.playerDamageTaken,
              playerHealingDone: round.playerHealingDone,
              detectedMistakes: round.detectedMistakes,
              teamDmgBySecond: round.teamDmgBySecond,
              enemyDmgBySecond: round.enemyDmgBySecond,
              teamHealBySecond: round.teamHealBySecond,
              enemyHealBySecond: round.enemyHealBySecond,
              ratingBefore,
              ratingAfter,
              roundNumber: round.roundNumber,
              sessionId,
              totalRoundsInSession: totalRounds
            })
          }
        } else {
          this.emit('processingRequired', {
            rawPath: finalPath,
            zoneName,
            bracket,
            result,
            durationSecs,
            matchStartedAt,
            recordingStartedAt,
            timeline,
            knownSpecs,
            healerNames,
            teamComp,
            enemyComp,
            playerRatings,
            playerAbsorb,
            playerDamageDone,
            playerDamageTaken,
            playerHealingDone,
            detectedMistakes,
            teamDmgBySecond,
            enemyDmgBySecond,
            teamHealBySecond,
            enemyHealBySecond,
            ratingBefore,
            ratingAfter,
            sessionId: isSoloShuffle ? sessionId : undefined
          })
        }

        this.session = null
        this.transitionTo('idle')
      })
      .catch((err: Error) => {
        console.error('[StateMachine] recorder.stop() failed:', err.message)
        this.session = null
        this.transitionTo('error')
        this.emit('error', { message: `Failed to stop recording: ${err.message}` })
      })
  }

  // Snapshots the current round's data into completedRounds.
  // Called with the timestamp of the NEXT round's ARENA_MATCH_START (rounds 1–5)
  // or the ARENA_MATCH_END timestamp (round 6 / final round).
  private finalizeCurrentRound(endTimestamp: Date): void {
    if (this.session === null || this.session.matchStartedAt === null) return

    const durationSecs = Math.max(
      0,
      (endTimestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    )
    const result = computeRoundResult(this.session.currentRoundRealDeaths)
    // Solo Shuffle re-teams every round — resolve rosters fresh per round, before the
    // next round's COMBATANT_INFO overwrites session.guidTeams.
    const { teamComp, enemyComp } = this.buildTeamRosters(this.resolveLocalTeam())
    const roundTimeline = [...this.session.pendingTimeline]

    this.session.completedRounds.push({
      roundNumber: this.session.roundNumber,
      matchStartedAt: this.session.matchStartedAt,
      durationSecs,
      result,
      timeline: roundTimeline,
      knownSpecs: Object.fromEntries(this.session.knownSpecs),
      healerNames: [...this.session.healerNames.keys()],
      teamComp,
      enemyComp,
      playerRatings: Object.fromEntries(this.session.playerRatings),
      playerAbsorb: Object.fromEntries(this.session.absorbDoneByName),
      playerDamageDone: Object.fromEntries(this.session.dmgDoneByName),
      playerDamageTaken: Object.fromEntries(this.session.dmgTakenByName),
      playerHealingDone: Object.fromEntries(this.session.healDoneByName),
      detectedMistakes: detectMistakes(roundTimeline, this.buildAuraWindowsByName()),
      teamDmgBySecond: buildChartBySecond(this.session.teamDmgSamples, durationSecs),
      enemyDmgBySecond: buildChartBySecond(this.session.enemyDmgSamples, durationSecs),
      teamHealBySecond: buildChartBySecond(this.session.teamHealSamples, durationSecs),
      enemyHealBySecond: buildChartBySecond(this.session.enemyHealSamples, durationSecs)
    })
  }

  // ---------------------------------------------------------------------------
  // Recorder helpers
  // ---------------------------------------------------------------------------

  private async startRecorder(): Promise<void> {
    if (this.session === null) return

    // roundNumber is 0 on zone enter (before round 1 starts), so use 1 for the filename.
    // For rounds 2-6, roundNumber is already the correct value (incremented in onMatchStart).
    const fileRound = this.session.roundNumber === 0 ? 1 : this.session.roundNumber
    const rawPath = buildRawPath(
      this.options.rawRecordingsDir,
      this.session.zoneName,
      this.session.sessionId,
      fileRound
    )

    this.session.rawOutputPath = rawPath

    try {
      await this.recorder.start(rawPath, this.options.recorder)
      // Set AFTER FFmpeg confirms it's capturing — this timestamp is used to compute
      // the trim offset, so it must reflect when actual frames started being written.
      if (this.session === null) return  // session cleared while awaiting start (e.g. arenaMatchEnd arrived first)
      this.session.recordingStartedAt = new Date()
      console.warn(`[StateMachine] Recorder started: ${rawPath}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[StateMachine] recorder.start() failed:', message)
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: `Failed to start recording: ${message}` })
    }
  }

  // Stops the recorder at the end of a solo shuffle round, emits processingRequired for
  // that round, then transitions back to 'waiting' so the next ARENA_MATCH_START can
  // start a fresh recorder.
  private async endSoloShuffleRound(endTimestamp: Date): Promise<void> {
    if (
      this.status !== 'recording' ||
      this.session === null ||
      this.session.matchStartedAt === null ||
      this.session.rawOutputPath === null ||
      this.session.endingFinalRound
    )
      return

    const {
      zoneName, bracket, sessionId, recordingStartedAt, roundNumber
    } = this.session

    if (bracket === null) return

    const matchStartedAt = this.session.matchStartedAt
    const isFinalRound = roundNumber === SOLO_SHUFFLE_ROUNDS_PER_SESSION
    // Set synchronously (before any await below) so a second near-simultaneous death
    // during the final round's post-roll delay can't re-enter this function.
    if (isFinalRound) this.session.endingFinalRound = true
    // Rounds 1-5 stop the recorder right at the death timestamp so the next round's
    // recorder.start() isn't delayed. The final round has no next round to rush for, so
    // its duration (and therefore the trim below) is padded with a few extra seconds —
    // otherwise the video cuts off at the exact death frame, missing the death
    // animation/results screen the user actually watched play out live.
    const durationSecs =
      Math.max(0, (endTimestamp.getTime() - matchStartedAt.getTime()) / 1000) +
      (isFinalRound ? SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS : 0)
    const result = computeRoundResult(this.session.currentRoundRealDeaths)
    // Solo Shuffle re-teams every round — resolve rosters fresh per round, before the
    // next round's COMBATANT_INFO overwrites session.guidTeams.
    const { teamComp, enemyComp } = this.buildTeamRosters(this.resolveLocalTeam())
    const timeline = [...this.session.pendingTimeline]
    const knownSpecs = Object.fromEntries(this.session.knownSpecs)
    const healerNames = [...this.session.healerNames.keys()]
    const playerRatings = Object.fromEntries(this.session.playerRatings)
    const playerAbsorb = Object.fromEntries(this.session.absorbDoneByName)
    const playerDamageDone = Object.fromEntries(this.session.dmgDoneByName)
    const playerDamageTaken = Object.fromEntries(this.session.dmgTakenByName)
    const playerHealingDone = Object.fromEntries(this.session.healDoneByName)
    // Captured synchronously (before the async stop() below) so a same-tick COMBATANT_INFO
    // for the next round can't overwrite auraWindows entries out from under this round.
    const detectedMistakes = detectMistakes(timeline, this.buildAuraWindowsByName())
    const teamDmgBySecond = buildChartBySecond(this.session.teamDmgSamples, durationSecs)
    const enemyDmgBySecond = buildChartBySecond(this.session.enemyDmgSamples, durationSecs)
    const teamHealBySecond = buildChartBySecond(this.session.teamHealSamples, durationSecs)
    const enemyHealBySecond = buildChartBySecond(this.session.enemyHealSamples, durationSecs)
    const ratingBefore = this.session.ratingBefore ?? undefined
    const ratingAfter = this.session.ratingAfter ?? undefined

    // For the final round, actually keep capturing for the padding above before
    // stopping — otherwise durationSecs would ask FFmpeg to trim past the end of the
    // raw file, which is harmless but pointless (nothing extra to show).
    if (isFinalRound) {
      await sleep(SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS * 1000)
    }

    // Transition and reset per-round state before awaiting stop, so that any
    // stray events arriving during the async stop don't affect the new round.
    const stopPromise = this.recorder.stop()
    this.transitionTo('waiting', zoneName)

    this.session.rawOutputPath = null
    this.session.matchStartedAt = null

    try {
      const finalPath = await stopPromise
      this.emit('processingRequired', {
        rawPath: finalPath,
        zoneName,
        bracket,
        result,
        durationSecs,
        matchStartedAt,
        recordingStartedAt,
        timeline,
        knownSpecs,
        healerNames,
        teamComp,
        enemyComp,
        playerRatings,
        playerAbsorb,
        playerDamageDone,
        playerDamageTaken,
        playerHealingDone,
        detectedMistakes,
        teamDmgBySecond,
        enemyDmgBySecond,
        teamHealBySecond,
        enemyHealBySecond,
        ratingBefore,
        ratingAfter,
        roundNumber,
        sessionId,
        totalRoundsInSession: 1
      })
      // The final round has no round 7 to hand off to — own the full session cleanup
      // here instead of waiting on ARENA_MATCH_END (which onMatchEnd now treats as a
      // no-op for this session, see the endingFinalRound check there).
      if (isFinalRound) {
        this.session = null
        this.playerClassInferred.clear()
        this.transitionTo('idle')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[StateMachine] endSoloShuffleRound: recorder.stop() failed:', message)
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: `Failed to stop recording: ${message}` })
    }
  }

  private async abortRecorder(): Promise<void> {
    if (!this.recorder.isRecording()) return
    try {
      await this.recorder.stop()
    } catch (err) {
      // Best-effort — log but don't escalate; we're abandoning the recording anyway
      console.warn('[StateMachine] abortRecorder error (ignored):', err instanceof Error ? err.message : String(err))
    }
  }

  // ---------------------------------------------------------------------------
  // Timeline event collectors
  // ---------------------------------------------------------------------------

  private onSpellCast(e: SpellCastEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    const isEnemy = (e.targetFlags & UNIT_FLAG_REACTION_HOSTILE) !== 0

    // Resolve any deferred COMBATANT_INFO for caster and target
    if (e.casterName) this.tryResolvePendingCombatant(e.casterGuid, e.casterName)
    if (e.targetName) this.tryResolvePendingCombatant(e.targetGuid, e.targetName)

    // Infer caster class from the spell ID.
    const inferredClass = SPELL_CLASS_MAP[e.spellId] as WowClass | undefined
    if (inferredClass !== undefined && e.casterName) {
      this.playerClassInferred.set(e.casterName, inferredClass)
    }

    // Track defensive and trinket cooldown usage per player.
    if (e.eventCategory === 'defensive' || e.eventCategory === 'trinket') {
      let cooldowns = this.session.playerCooldowns.get(e.casterName)
      if (cooldowns === undefined) {
        cooldowns = new Map()
        this.session.playerCooldowns.set(e.casterName, cooldowns)
      }
      cooldowns.set(e.spellId, relSecs)
    }

    // Check if this CC targets a confirmed enemy healer.
    const isHealerCC =
      e.eventCategory === 'cc' &&
      isEnemy &&
      e.targetName !== '' &&
      this.session.healerNames.has(e.targetName)
        ? true
        : undefined

    // DR check: is the target immune to this CC?
    let isMistake: boolean | undefined
    let mistakeReason: string | undefined
    if (e.eventCategory === 'cc' && e.targetGuid) {
      const drCategory = DR_CATEGORY[e.spellId]
      if (drCategory !== undefined) {
        const key = `${e.targetGuid}:${drCategory}`
        const counter = this.session.drCounters.get(key)
        if (counter !== undefined && relSecs < counter.windowExpiresAt && counter.count >= 2) {
          isMistake = true
          mistakeReason = 'DR immune'
        }
      }
    }

    // Burst without healer CC'd — our team uses offensive CD while no enemy healer is controlled
    if (!isMistake && e.eventCategory === 'offensive' && isEnemy && this.session.healerGuids.size > 0) {
      const anyHealerCCd = [...this.session.activeCCs.keys()].some((key) => {
        const guid = key.split(':')[0] ?? ''
        return this.session!.healerGuids.has(guid)
      })
      if (!anyHealerCCd) {
        isMistake = true
        mistakeReason = "No healer CC'd during burst"
      }
    }

    // HP%-context for defensive casts (requires Advanced Combat Logging) — used by the
    // mistake detector to flag defensives used too late (already low HP when cast).
    const casterHpPct =
      e.eventCategory === 'defensive'
        ? this.lookupHpPct(e.casterGuid, relSecs)
        : undefined

    const timelineIdx = this.session.pendingTimeline.length
    this.session.pendingTimeline.push({
      timestamp: relSecs,
      type: e.eventCategory,
      spellId: e.spellId,
      spellName: e.spellName,
      casterName: e.casterName || undefined,
      targetName: e.targetName || undefined,
      target: isEnemy ? 'enemy' : 'player',
      isHealerCC,
      isMistake,
      mistakeReason,
      casterHpPct
    })

    // Buffer interrupt events for resolution via SPELL_INTERRUPT (success) or Precognition (failure).
    // Use a 2-second TTL window — stale entries are pruned when new interrupts arrive.
    if (e.eventCategory === 'interrupt') {
      const INTERRUPT_TTL_SECS = 2
      // Prune stale entries before adding new ones
      for (const [k, v] of this.session.pendingInterruptByCaster) {
        if (relSecs - v.relSecs > INTERRUPT_TTL_SECS) this.session.pendingInterruptByCaster.delete(k)
      }
      for (const [k, v] of this.session.pendingInterruptByTarget) {
        if (relSecs - v.relSecs > INTERRUPT_TTL_SECS) this.session.pendingInterruptByTarget.delete(k)
      }
      this.session.pendingInterruptByCaster.set(e.casterGuid, { timelineIdx, targetGuid: e.targetGuid, relSecs })
      this.session.pendingInterruptByTarget.set(e.targetGuid, { timelineIdx, relSecs })
    }
  }

  private onHealerCast(e: HealerCastEvent): void {
    if (this.session === null) return
    this.session.healerGuids.add(e.casterGuid)
    // Store name→guid so isHealerCC check in onSpellCast can look up by targetName
    this.session.healerNames.set(e.casterName, e.casterGuid)
  }

  private onCombatantInfo(e: CombatantInfoEvent): void {
    if (this.session === null) return

    // Store team assignment by GUID for chart damage attribution
    this.session.guidTeams.set(e.playerGuid, e.team)

    if (this.localPlayerGuid !== null && e.playerGuid === this.localPlayerGuid) {
      this.currentMatchLocalRating = e.personalRating
      this.checkPendingRatingAgainstResult(e.personalRating)
    }

    // Always cache deferred COMBATANT_INFO — name may not be in GUID cache yet at match start
    this.session.pendingCombatantByGuid.set(e.playerGuid, {
      specId: e.specId,
      personalRating: e.personalRating,
      team: e.team
    })

    // If name is already known, resolve immediately
    if (e.playerName !== '') {
      this.resolveCombatantInfo(e.playerGuid, e.playerName, e.specId, e.personalRating)
    }
  }

  // Called when COMBATANT_INFO was deferred and we now know the player's name
  private tryResolvePendingCombatant(guid: string, name: string): void {
    if (this.session === null || name === '') return
    const pending = this.session.pendingCombatantByGuid.get(guid)
    if (pending === undefined) return
    this.session.pendingCombatantByGuid.delete(guid)
    this.resolveCombatantInfo(guid, name, pending.specId, pending.personalRating)
  }

  private resolveCombatantInfo(
    guid: string,
    name: string,
    specId: number | null,
    personalRating: number
  ): void {
    if (this.session === null) return

    if (specId !== null) {
      const entry = (WOW_SPEC_ID_MAP as Record<number, { spec: string; class: string; isHealer: boolean }>)[specId]
      if (entry !== undefined) {
        this.session.knownSpecs.set(name, entry.spec)
        // Also update playerClassInferred so "could use" works immediately
        this.playerClassInferred.set(name, entry.class as WowClass)
        if (entry.isHealer) {
          this.session.healerGuids.add(guid)
          this.session.healerNames.set(name, guid)
        }
      }
    }

    if (personalRating > 0) {
      this.session.playerRatings.set(name, personalRating)
    }
  }

  // Spells the generic auraWindows tracker cares about, for mistake-detector
  // correlation (damage/CC into immunity, burst into defensive, trinket-on-low-value-CC).
  // Deliberately independent of activeCCs/drCounters below, which stay CC-only.
  private static isTrackedAuraWindow(spellId: number): boolean {
    return SPELL_IDS_DEFENSIVE.has(spellId) || SPELL_IDS_IMMUNITY.has(spellId) || LOW_VALUE_CC_IDS.has(spellId)
  }

  private onAuraApplied(e: SpellAuraEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000

    // CC-only bookkeeping (activeCCs + DR) — unchanged from before the parser's aura
    // filter was widened to also admit defensive/immunity auras (see isTrackedAuraWindow
    // below for that separate path), so "no healer CC'd" etc. keep seeing CC-only state.
    if (SPELL_IDS_CC.has(e.spellId)) {
      const key = `${e.targetGuid}:${e.spellId}`

      // Find the most recent matching CC cast in pendingTimeline to back-fill duration later.
      let timelineIndex = -1
      for (let i = this.session.pendingTimeline.length - 1; i >= 0; i--) {
        const ev = this.session.pendingTimeline[i]!
        if (ev.type === 'cc' && ev.spellId === e.spellId && ev.targetName === e.targetName) {
          timelineIndex = i
          break
        }
      }

      this.session.activeCCs.set(key, {
        spellId: e.spellId,
        spellName: e.spellName,
        startRelSecs: relSecs,
        timelineIndex
      })

      // Update DR counter: increment count, keep existing window expiry if still active.
      const drCategory = DR_CATEGORY[e.spellId]
      if (drCategory !== undefined) {
        const drKey = `${e.targetGuid}:${drCategory}`
        const existing = this.session.drCounters.get(drKey)
        if (existing !== undefined && relSecs < existing.windowExpiresAt) {
          existing.count++
        } else {
          // Fresh window — first application in this cycle.
          this.session.drCounters.set(drKey, { count: 1, windowExpiresAt: Infinity })
        }
      }
    }

    if (RecorderStateMachine.isTrackedAuraWindow(e.spellId)) {
      const windows = this.session.auraWindows.get(e.targetGuid) ?? []
      windows.push({ spellId: e.spellId, spellName: e.spellName, start: relSecs, end: Infinity })
      this.session.auraWindows.set(e.targetGuid, windows)
    }
  }

  private onAuraRemoved(e: SpellAuraEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000

    if (SPELL_IDS_CC.has(e.spellId)) {
      const key = `${e.targetGuid}:${e.spellId}`
      const active = this.session.activeCCs.get(key)

      if (active !== undefined) {
        const duration = Math.max(0, relSecs - active.startRelSecs)
        // Back-fill duration on the corresponding timeline event.
        if (active.timelineIndex >= 0) {
          const ev = this.session.pendingTimeline[active.timelineIndex]
          if (ev !== undefined) ev.duration = parseFloat(duration.toFixed(1))
        }
        this.session.activeCCs.delete(key)
      }

      // Update DR window: 18s from when the aura expired.
      const drCategory = DR_CATEGORY[e.spellId]
      if (drCategory !== undefined) {
        const drKey = `${e.targetGuid}:${drCategory}`
        const counter = this.session.drCounters.get(drKey)
        if (counter !== undefined) {
          counter.windowExpiresAt = relSecs + 18
        }
      }
    }

    if (RecorderStateMachine.isTrackedAuraWindow(e.spellId)) {
      const windows = this.session.auraWindows.get(e.targetGuid)
      if (windows !== undefined) {
        for (let i = windows.length - 1; i >= 0; i--) {
          if (windows[i]!.spellId === e.spellId && windows[i]!.end === Infinity) {
            windows[i]!.end = relSecs
            break
          }
        }
      }
    }
  }

  private onUnitDied(e: UnitDiedEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    // Only track player deaths — skip NPC/pet kills (Magus of the Dead, Lesser Ghoul, etc.)
    if (!e.unitGuid.startsWith('Player-')) return

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    const isEnemy = (e.destFlags & UNIT_FLAG_REACTION_HOSTILE) !== 0

    // Track real (non-unconscious) deaths for solo shuffle round result computation.
    // unconscious=true means Feign Death, Ankh, etc. — unit didn't actually die.
    if (this.session.isSoloShuffle && !e.unconscious) {
      this.session.currentRoundRealDeaths.push({ isEnemy })
    }

    // If class not inferred from spells yet, derive from COMBATANT_INFO spec
    if (!this.playerClassInferred.has(e.unitName)) {
      const spec = this.session.knownSpecs.get(e.unitName)
      if (spec !== undefined) {
        for (const entry of Object.values(WOW_SPEC_ID_MAP)) {
          if (entry.spec === spec) {
            this.playerClassInferred.set(e.unitName, entry.class as WowClass)
            break
          }
        }
      }
    }

    // Compute unused defensives for any player death where class is known.
    // "Could use" display in the UI is renderer-side; backend always provides the data.
    const unusedDefensives = computeUnusedDefensives(
      e.unitName,
      relSecs,
      this.playerClassInferred,
      this.session.playerCooldowns
    )

    // Collect the death-recap window of incoming damage/healing, HP%-annotated.
    const healthSamples = this.session.recentHealthByGuid.get(e.unitGuid) ?? []
    const hpPctAt = (hitRelSecs: number): number | undefined => {
      let hpPct: number | undefined
      let closestDelta = Infinity
      for (const s of healthSamples) {
        const delta = hitRelSecs - s.relSecs
        if (delta >= 0 && delta < closestDelta && s.maxHp > 0) {
          closestDelta = delta
          hpPct = Math.round((s.hp / s.maxHp) * 100)
        }
      }
      return hpPct
    }
    const recentHits = this.session.recentDamageByGuid.get(e.unitGuid) ?? []
    const deathSummary = recentHits
      .filter((h) => relSecs - h.relSecs <= DEATH_RECAP_WINDOW_SECS)
      .map((h) => ({ ...h, relSecs: parseFloat((h.relSecs - relSecs).toFixed(2)), hpPct: hpPctAt(h.relSecs) }))

    const recentHeals = this.session.recentHealingByGuid.get(e.unitGuid) ?? []
    const deathHealing = recentHeals
      .filter((h) => relSecs - h.relSecs <= DEATH_RECAP_WINDOW_SECS)
      .map((h) => ({ ...h, relSecs: parseFloat((h.relSecs - relSecs).toFixed(2)), hpPct: hpPctAt(h.relSecs) }))

    // CC applied to the dying player and defensives/trinket they used, both drawn from
    // the round's timeline (already-recorded cast events) rather than new state.
    const deathCCTaken = this.session.pendingTimeline
      .filter(
        (ev) =>
          ev.type === 'cc' &&
          ev.targetName === e.unitName &&
          relSecs - ev.timestamp >= 0 &&
          relSecs - ev.timestamp <= DEATH_RECAP_WINDOW_SECS
      )
      .map((ev) => ({
        spellId: ev.spellId,
        spellName: ev.spellName ?? '',
        relSecs: parseFloat((ev.timestamp - relSecs).toFixed(2)),
        casterName: ev.casterName
      }))
    const deathDefensivesUsed = this.session.pendingTimeline
      .filter(
        (ev) =>
          (ev.type === 'defensive' || ev.type === 'trinket') &&
          ev.casterName === e.unitName &&
          relSecs - ev.timestamp >= 0 &&
          relSecs - ev.timestamp <= DEATH_RECAP_WINDOW_SECS
      )
      .map((ev) => ({
        spellId: ev.spellId,
        spellName: ev.spellName ?? '',
        relSecs: parseFloat((ev.timestamp - relSecs).toFixed(2))
      }))

    this.session.pendingTimeline.push({
      timestamp: relSecs,
      type: isEnemy ? 'death-enemy' : 'death-player',
      unit: e.unitName,
      unusedDefensives: unusedDefensives.length > 0 ? unusedDefensives : undefined,
      deathSummary: deathSummary.length > 0 ? deathSummary : undefined,
      deathHealing: deathHealing.length > 0 ? deathHealing : undefined,
      deathCCTaken: deathCCTaken.length > 0 ? deathCCTaken : undefined,
      deathDefensivesUsed: deathDefensivesUsed.length > 0 ? deathDefensivesUsed : undefined
    })

    // Solo shuffle: end this round's recording on any real player death.
    // The ~35 s gap before the next ARENA_MATCH_START lets FFmpeg finalise cleanly.
    if (this.session.isSoloShuffle && !e.unconscious) {
      void this.endSoloShuffleRound(e.timestamp)
    }
  }

  private onSpellInterruptSuccess(e: SpellInterruptSuccessEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    // Resolve via casterGuid: find the pending interrupt this caster used.
    const pending = this.session.pendingInterruptByCaster.get(e.casterGuid)
    if (pending !== undefined) {
      const ev = this.session.pendingTimeline[pending.timelineIdx]
      if (ev !== undefined && ev.type === 'interrupt') {
        ev.isSuccessful = true
        ev.interruptedSpell = e.interruptedSpellName
      }
      this.session.pendingInterruptByCaster.delete(e.casterGuid)
      this.session.pendingInterruptByTarget.delete(pending.targetGuid)
    }
  }

  private onPrecognitionGained(e: PrecognitionGainedEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    // Precognition applies to the player who was interrupt-targeted while not casting.
    // Resolve via targetGuid to find who cast the failed interrupt.
    const pending = this.session.pendingInterruptByTarget.get(e.playerGuid)
    if (pending !== undefined) {
      const ev = this.session.pendingTimeline[pending.timelineIdx]
      if (ev !== undefined && ev.type === 'interrupt') {
        ev.isSuccessful = false
        ev.isMistake = true
        ev.mistakeReason = 'Bad interrupt'
      }
      // Find and clean up the caster-side entry too
      for (const [guid, p] of this.session.pendingInterruptByCaster) {
        if (p.timelineIdx === pending.timelineIdx) {
          this.session.pendingInterruptByCaster.delete(guid)
          break
        }
      }
      this.session.pendingInterruptByTarget.delete(e.playerGuid)
    }
  }

  private onArenaMatchStats(e: ArenaMatchStatsEntryEvent): void {
    if (this.session === null) return
    // team 0 = local player's team in ARENA_MATCH_STATS; only store the local player's rating.
    // We use the localPlayerName to confirm identity; fall back to team index if name unknown.
    const isLocalPlayer =
      this.localPlayerName !== null
        ? e.playerName.toLowerCase() === this.localPlayerName.toLowerCase()
        : e.team === 0
    if (isLocalPlayer && e.ratingBefore > 0) {
      this.session.ratingBefore = e.ratingBefore
      this.session.ratingAfter = e.ratingAfter
    }
  }

  private onUnitHealth(e: UnitHealthEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    if (relSecs < 0) return

    const samples = this.session.recentHealthByGuid.get(e.unitGuid) ?? []
    samples.push({ relSecs, hp: e.hp, maxHp: e.maxHp })
    // Trim to the death-recap window
    const cutoff = relSecs - DEATH_RECAP_WINDOW_SECS
    const trimmed = cutoff > 0 ? samples.filter((s) => s.relSecs >= cutoff) : samples
    this.session.recentHealthByGuid.set(e.unitGuid, trimmed)
  }

  private onSpellDamage(e: SpellDamageEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    // Resolve any deferred COMBATANT_INFO
    if (e.casterName) this.tryResolvePendingCombatant(e.casterGuid, e.casterName)
    if (e.targetName) this.tryResolvePendingCombatant(e.targetGuid, e.targetName)

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    if (relSecs < 0) return

    // Track damage for death recap (sliding window per target)
    const hits = this.session.recentDamageByGuid.get(e.targetGuid) ?? []
    hits.push({ relSecs, spellId: e.spellId, spellName: e.spellName, amount: e.amount, casterName: e.casterName || undefined, isCritical: e.isCritical })
    // Trim to the death-recap window
    const cutoff = relSecs - DEATH_RECAP_WINDOW_SECS
    const trimmed = cutoff > 0 ? hits.filter((h) => h.relSecs >= cutoff) : hits
    this.session.recentDamageByGuid.set(e.targetGuid, trimmed)

    // Per-player meters (Details!/Skada-style Damage Done / Damage Taken).
    if (e.casterName) {
      this.session.dmgDoneByName.set(e.casterName, (this.session.dmgDoneByName.get(e.casterName) ?? 0) + e.amount)
    }
    if (e.targetName) {
      this.session.dmgTakenByName.set(e.targetName, (this.session.dmgTakenByName.get(e.targetName) ?? 0) + e.amount)
    }

    // Track damage for team charts — use GUID team assignment from COMBATANT_INFO
    const sec = Math.floor(relSecs)
    const team = this.session.guidTeams.get(e.casterGuid)
    if (team === 1) {
      // Local player's team
      this.session.teamDmgAccum += e.amount
      this.session.teamDmgSamples.push({ sec, total: this.session.teamDmgAccum })
    } else if (team === 0) {
      // Enemy team
      this.session.enemyDmgAccum += e.amount
      this.session.enemyDmgSamples.push({ sec, total: this.session.enemyDmgAccum })
    }
  }

  private onSpellHealAmount(e: SpellHealAmountEvent): void {
    if (this.status !== 'recording' || this.session === null || this.session.matchStartedAt === null)
      return

    if (e.casterName) this.tryResolvePendingCombatant(e.casterGuid, e.casterName)
    if (e.targetName) this.tryResolvePendingCombatant(e.targetGuid ?? '', e.targetName)

    const relSecs = (e.timestamp.getTime() - this.session.matchStartedAt.getTime()) / 1000
    if (relSecs < 0) return

    // Per-player meter (Details!/Skada-style Healing Done).
    if (e.casterName) {
      this.session.healDoneByName.set(e.casterName, (this.session.healDoneByName.get(e.casterName) ?? 0) + e.amount)
    }

    // Track healing received for death recap (sliding window per target)
    if (e.targetGuid) {
      const hits = this.session.recentHealingByGuid.get(e.targetGuid) ?? []
      hits.push({ relSecs, spellId: e.spellId, spellName: e.spellName ?? '', amount: e.amount, casterName: e.casterName || undefined })
      const cutoff = relSecs - DEATH_RECAP_WINDOW_SECS
      const trimmed = cutoff > 0 ? hits.filter((h) => h.relSecs >= cutoff) : hits
      this.session.recentHealingByGuid.set(e.targetGuid, trimmed)
    }

    const sec = Math.floor(relSecs)
    const team = this.session.guidTeams.get(e.casterGuid)
    if (team === 1) {
      this.session.teamHealAccum += e.amount
      this.session.teamHealSamples.push({ sec, total: this.session.teamHealAccum })
    } else if (team === 0) {
      this.session.enemyHealAccum += e.amount
      this.session.enemyHealSamples.push({ sec, total: this.session.enemyHealAccum })
    }
  }

  private onSpellAbsorb(e: SpellAbsorbEvent): void {
    if (this.status !== 'recording' || this.session === null) return
    if (e.casterName) this.tryResolvePendingCombatant(e.casterGuid, e.casterName)
    if (!e.casterName) return

    const total = this.session.absorbDoneByName.get(e.casterName) ?? 0
    this.session.absorbDoneByName.set(e.casterName, total + e.amount)
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  private transitionTo(status: RecorderStatus, zone?: string): void {
    const prev = this.status
    this.status = status
    console.warn(`[StateMachine] ${prev} → ${status}` + (zone !== undefined ? ` (${zone})` : ''))
    this.emit('statusChanged', { status, zone })
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// Determines the round result for solo shuffle from real (non-unconscious) deaths.
// A round is a WIN if more enemies died than friendlies; LOSS otherwise.
function computeRoundResult(realDeaths: Array<{ isEnemy: boolean }>): ArenaResult {
  const enemyDeaths = realDeaths.filter((d) => d.isEnemy).length
  const friendlyDeaths = realDeaths.filter((d) => !d.isEnemy).length
  return enemyDeaths > friendlyDeaths ? 'WIN' : 'LOSS'
}

// Returns the names of defensive abilities that were available (off cooldown) at the
// moment of death. Used to populate TimelineEvent.unusedDefensives for death events.
function computeUnusedDefensives(
  unitName: string,
  deathRelSecs: number,
  classMap: ReadonlyMap<string, WowClass>,
  cooldownMap: Map<string, Map<number, number>>
): string[] {
  const className = classMap.get(unitName)
  if (className === undefined) return []

  const defensives = getClassDefensives(className)
  const playerCDs = cooldownMap.get(unitName)
  const available: string[] = []

  for (const ability of defensives) {

    const allIds = [ability.spellId, ...(ability.alternateIds ?? [])]

    // Find the most recent use of this ability (any of its spell IDs).
    let lastUsed: number | undefined
    for (const id of allIds) {
      const used = playerCDs?.get(id)
      if (used !== undefined && (lastUsed === undefined || used > lastUsed)) {
        lastUsed = used
      }
    }

    const isOnCooldown =
      lastUsed !== undefined && deathRelSecs - lastUsed < ability.cooldownSecs

    if (!isOnCooldown) {
      available.push(ability.name)
    }
  }

  return available
}

// Converts a list of {sec, total} samples into a per-second cumulative array.
// Index = second from match start, value = cumulative damage/heal at that second.
function buildChartBySecond(samples: Array<{ sec: number; total: number }>, durationSecs: number): number[] {
  if (samples.length === 0) return []
  const maxSec = Math.ceil(durationSecs)
  const result: number[] = new Array(maxSec + 1).fill(0)
  for (const s of samples) {
    if (s.sec <= maxSec) {
      result[s.sec] = Math.max(result[s.sec] ?? 0, s.total)
    }
  }
  // Forward-fill: each second should have at least the previous second's value
  let prev = 0
  for (let i = 0; i <= maxSec; i++) {
    const v = result[i] ?? 0
    result[i] = Math.max(v, prev)
    prev = result[i] ?? 0
  }
  return result
}

function buildRawPath(dir: string, zone: string, sessionId: string, round: number): string {
  const safeZone = zone.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const safeTs = sessionId.replace(/[^0-9T]/g, '').slice(0, 15) // "20260415T200000"
  return join(dir, `raw_${safeZone}_${safeTs}_r${round}.mp4`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
