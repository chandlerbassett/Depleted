// Mythic+ and raid recording state machine: idle → recording → processing → idle.
// A Mythic+ recording is one key; a raid recording is one boss pull.
//
// Shares the recorder with test mode, so it checks recorder.isRecording() before
// starting rather than clobbering a test clip.
//
// State transitions:
//   idle (armed)            : zoneChanged into a Mythic dungeon — the recorder's rolling
//                             buffer starts (native capture), or recorder.start() is called
//                             (other recorders), so the key going in and the countdown are
//                             on video
//   idle       → recording  : challengeModeStart — recorder.start() opens a file with the
//                             buffered footage, takes over the armed recording, or starts
//                             fresh if nothing was armed
//   recording  → processing : challengeModeEnd (after MYTHIC_PLUS_POST_ROLL_SECS), or
//                             MYTHIC_PLUS_ABANDON_TIMEOUT_SECS after leaving the dungeon,
//                             or a new challengeModeStart while a key is still open
//   processing → idle       : recorder stopped, processingRequired emitted
//   any        → error      : recorder crashes or start/stop fails
//
// Raids follow the same path with ENCOUNTER_START / ENCOUNTER_END in place of the key
// start and end (RAID_POST_ROLL_SECS after the end). The recorder is armed on entering
// the raid and again after every pull, so each pull gets the same pre-roll.
//
// Nothing is aborted on zone exit: a key is 30+ minutes of footage, so an abandoned key is still saved (outcome 'abandoned') rather than thrown away.

import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { join } from 'path'
import type {
  DeathHit,
  MythicPlusEncounter,
  MythicPlusInfo,
  MythicPlusOutcome,
  RaidDifficulty,
  RaidInfo,
  RaidOutcome,
  RecorderStatus,
  TimelineEvent
} from '@shared/ipc.types'
import {
  WOW_SPEC_ID_MAP,
  DEATH_RECAP_WINDOW_SECS,
  MYTHIC_DUNGEON_DIFFICULTY_IDS,
  MYTHIC_PLUS_ABANDON_TIMEOUT_SECS,
  MYTHIC_PLUS_ARM_MAX_LOG_AGE_SECS,
  MYTHIC_PLUS_ARMED_MAX_SECS,
  MYTHIC_PLUS_ARMED_RESTART_SECS,
  MYTHIC_PLUS_IDLE_TIMEOUT_SECS,
  MYTHIC_PLUS_POST_ROLL_SECS,
  MYTHIC_PLUS_PRE_ROLL_SECS,
  PRE_ROLL_BUFFER_SECS,
  RAID_ARMED_QUIET_MAX_SECS,
  RAID_DIFFICULTY_IDS,
  RAID_POST_ROLL_SECS,
  RAID_PRE_ROLL_SECS
} from '@shared/constants'
import type { CombatLogWatcher } from '../combatlog/CombatLogWatcher'
import type {
  ChallengeModeEndEvent,
  ChallengeModeStartEvent,
  DamageDoneEvent,
  CombatantInfoEvent,
  EncounterEndEvent,
  EncounterStartEvent,
  LogActivityEvent,
  BuffChangeEvent,
  SpellCastEvent,
  SpellDamageEvent,
  SpellHealAmountEvent,
  SpellInterruptSuccessEvent,
  UnitDiedEvent,
  ZoneChangedEvent
} from '../combatlog/CombatLogParser'
import type { CaptureRecorder, RecorderOptions } from './CaptureRecorder'
import { CoachCollector } from '../coach/CoachCollector'
import { rawInfoPath, type ProcessingRequiredEvent, type RawRecordingInfo, type StateMachineEventMap } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MythicPlusStateMachineOptions {
  // Directory for raw (untrimmed) recordings before post-processing
  rawRecordingsDir: string
  // Options forwarded to recorder.start()
  recorder?: RecorderOptions
  // Overridable for tests
  postRollSecs?: number
  // 0 turns off arming on dungeon entry (the video then starts at the key start)
  preRollSecs?: number
  armedRestartSecs?: number
  // Rolling buffer length when the recorder has one (see PRE_ROLL_BUFFER_SECS)
  bufferSecs?: number
  abandonTimeoutSecs?: number
  idleTimeoutSecs?: number
  raidPostRollSecs?: number
  raidPreRollSecs?: number
  // Raid difficulties to record boss pulls in; none (the default) turns raids off
  raidDifficulties?: RaidDifficulty[]
  // Whether the game is running. When given (and the recorder has a rolling buffer), the
  // buffer runs whenever the game is open, not only after zoning in: WoW writes the
  // zone-in lines to disk together with the key start, so arming on zone-in alone
  // leaves keys with no pre-roll.
  isGameRunning?: () => Promise<boolean>
  // The Settings switch for the above (default on). Off, keys and first pulls can start
  // late, since the buffer only starts once the log shows the dungeon or raid.
  bufferWhileGameOpen?: boolean
  gameCheckMs?: number
}

// How often to check whether the game is running
const GAME_CHECK_MS = 15_000
// After the standby buffer fails or dies, wait this long before starting it again
const STANDBY_RETRY_MS = 60_000

// How often to check whether the log went quiet while armed in a raid
const RAID_QUIET_CHECK_MS = 60_000

// Unit flag bits (COMBATLOG_OBJECT_*) used to pick out the local party.
const UNIT_FLAG_AFFILIATION_MINE = 0x1
const UNIT_FLAG_AFFILIATION_PARTY = 0x2
const UNIT_FLAG_AFFILIATION_RAID = 0x4
const UNIT_FLAG_TYPE_PLAYER = 0x400

// The player whose combat log this is (the one recording)
function isLocalPlayer(guid: string, flags: number): boolean {
  return guid.startsWith('Player-') && (flags & UNIT_FLAG_TYPE_PLAYER) !== 0 && (flags & UNIT_FLAG_AFFILIATION_MINE) !== 0
}

function isPartyPlayer(flags: number): boolean {
  return (
    (flags & UNIT_FLAG_TYPE_PLAYER) !== 0 &&
    (flags & (UNIT_FLAG_AFFILIATION_MINE | UNIT_FLAG_AFFILIATION_PARTY | UNIT_FLAG_AFFILIATION_RAID)) !== 0
  )
}

interface OpenEncounter {
  encounterId: number
  name: string
  startRelSecs: number
}

// Armed on entering a Mythic dungeon, before any key. With a rolling buffer (native
// capture) that's all it is: the next CHALLENGE_MODE_START opens a file that starts with
// the buffered footage. Otherwise it's a real recording the key takes over. Either way
// the trim keeps only the pre-roll before the key.
interface ArmedRecording {
  // Rolling buffer rather than a recording; rawOutputPath is unused
  buffered: boolean
  instanceId: number
  rawOutputPath: string
  started: Promise<boolean>
  recordingStartedAt: Date | null
  restartTimer: ReturnType<typeof setTimeout> | null
  // Set when it's thrown away (left the dungeon, restart, test mode)
  cancelled: boolean
  failure: string | null
  // Raids wait hours between pulls, so these keep re-arming with no time limit
  forRaid: boolean
}

interface RaidPull {
  encounter: EncounterStartEvent
  difficulty: RaidDifficulty
  pullNumber: number
}

type SessionOutcome = MythicPlusOutcome | RaidOutcome

// A key or a raid pull being recorded
interface KeySession {
  zoneName: string
  instanceId: number
  // Key start or pull start (log time); timeline seconds count from here
  startedAt: Date
  // Exactly one is set
  key: ChallengeModeStartEvent | null
  pull: RaidPull | null
  rawOutputPath: string
  // Resolves true once the recorder is capturing, false if it failed to start
  started: Promise<boolean>
  // Wall-clock time the recorder confirmed it was capturing. null until then.
  recordingStartedAt: Date | null
  timeline: TimelineEvent[]
  encounters: MythicPlusEncounter[]
  openEncounter: OpenEncounter | null
  // Party member GUID → name, from COMBATANT_INFO and party-flagged events
  roster: Map<string, string>
  // GUID of the player recording, from the first unit flagged as theirs
  selfGuid: string | null
  recentDamageByGuid: Map<string, DeathHit[]>
  deathsByPlayer: Map<string, number>
  interruptsByPlayer: Map<string, number>
  dmgTakenByName: Map<string, number>
  dmgDoneByName: Map<string, number>
  healDoneByName: Map<string, number>
  // Casts, buffs and per-second damage/healing for the coach (coach.json)
  coach: CoachCollector
  abandonTimer: ReturnType<typeof setTimeout> | null
  // Last log line seen (log time) and when we saw it (wall clock), for the idle check
  lastLogTimestamp: Date
  lastLogWallMs: number
  idleTimer: ReturnType<typeof setInterval> | null
  // Set once finalize() has begun so late events don't double-finalize
  ending: boolean
}

// ---------------------------------------------------------------------------
// MythicPlusStateMachine
// ---------------------------------------------------------------------------

export class MythicPlusStateMachine extends EventEmitter {
  private status: RecorderStatus = 'idle'
  private session: KeySession | null = null
  // Resolves once the in-flight finalize() has stopped the recorder — a new key that
  // starts mid-finalize waits on this before starting the recorder again.
  private finalizing: Promise<void> = Promise.resolve()
  // Ends the running post-roll early, so a key started right after another doesn't
  // wait for the previous key's completion-screen footage before recording.
  private cutPostRoll: (() => void) | null = null
  private armed: ArmedRecording | null = null
  // Resolves once a discarded armed recording has stopped
  private disarming: Promise<void> = Promise.resolve()
  private disarmsInFlight = 0
  // The last zone the log moved into, to re-arm in a raid after each pull
  private zone: ZoneChangedEvent | null = null
  // Pulls of each boss (encounterId → count) since entering the raid instance
  private pullCounts = new Map<number, number>()
  private pullCountsInstanceId: number | null = null
  private quitting = false
  // Wall clock of the last log line seen, in or out of a recording
  private lastLogWallMs = Date.now()
  // The game is open, so the rolling buffer stays up between keys and pulls (standby)
  private gameOpen = false
  private gameCheckTimer: ReturnType<typeof setInterval> | null = null
  private gameCheckInFlight = false
  // Resolves once an in-flight standby buffer start has finished
  private standbyStarting: Promise<void> = Promise.resolve()
  private standbyStartInFlight = false
  private standbyRetryAfterMs = 0
  private readonly watcher: CombatLogWatcher
  private readonly recorder: CaptureRecorder
  private options: MythicPlusStateMachineOptions

  constructor(
    watcher: CombatLogWatcher,
    recorder: CaptureRecorder,
    options: MythicPlusStateMachineOptions
  ) {
    super()
    this.watcher = watcher
    this.recorder = recorder
    this.options = options
    this.bindParserEvents()
    this.bindRecorderEvents()
    if (options.bufferWhileGameOpen !== false) this.startGameChecks()
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

  // The Settings switch: keep the rolling buffer up whenever WoW is open
  updateBufferWhileGameOpen(enabled: boolean): void {
    this.options = { ...this.options, bufferWhileGameOpen: enabled }
    if (enabled) {
      this.startGameChecks()
      return
    }
    if (this.gameCheckTimer !== null) clearInterval(this.gameCheckTimer)
    this.gameCheckTimer = null
    this.gameOpen = false
    void this.standbyStarting.then(() => this.stopBufferIfUnused())
  }

  updateRaidDifficulties(difficulties: RaidDifficulty[]): void {
    this.options = { ...this.options, raidDifficulties: difficulties }
    if (this.armed?.forRaid === true && this.raidDifficultyOf(this.zone?.difficultyId ?? 0) === null) this.disarm()
    else if (this.session === null) this.armForZone()
  }

  // Frees the recorder if it's only armed (no key running), e.g. for a test recording.
  async releaseArmedRecorder(): Promise<void> {
    // Keep the standby buffer from coming back before the test recording starts
    this.standbyRetryAfterMs = Date.now() + STANDBY_RETRY_MS
    this.disarm()
    await Promise.all([this.disarming, this.standbyStarting])
    if (this.session === null) await this.stopBuffer()
  }

  // Quitting: a key still running is saved as abandoned, up to now rather than the last
  // log line (the log can stall well before the player stops), instead of leaving its
  // raw file behind. An armed recording with no key is thrown away. Resolves once the
  // recorder has stopped and processingRequired has been emitted.
  async finishForQuit(): Promise<void> {
    this.quitting = true
    if (this.gameCheckTimer !== null) clearInterval(this.gameCheckTimer)
    this.gameCheckTimer = null
    const session = this.session
    if (session !== null && !session.ending) {
      const endTimestamp = new Date(session.lastLogTimestamp.getTime() + (Date.now() - session.lastLogWallMs))
      this.finalize('abandoned', endTimestamp, null)
    }
    this.cutPostRoll?.()
    this.disarm()
    await Promise.all([this.finalizing, this.disarming, this.standbyStarting])
    await this.stopBuffer()
  }

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

  // ---------------------------------------------------------------------------
  // Binding
  // ---------------------------------------------------------------------------

  private bindParserEvents(): void {
    this.watcher.onParser('challengeModeStart', (e) => this.onKeyStart(e))
    this.watcher.onParser('challengeModeEnd', (e) => this.onKeyEnd(e))
    this.watcher.onParser('encounterStart', (e) => this.onEncounterStart(e))
    this.watcher.onParser('encounterEnd', (e) => this.onEncounterEnd(e))
    this.watcher.onParser('zoneChanged', (e) => this.onZoneChanged(e))
    this.watcher.onParser('logActivity', (e) => this.onLogActivity(e))
    this.watcher.onParser('combatantInfo', (e) => this.onCombatantInfo(e))
    this.watcher.onParser('unitDied', (e) => this.onUnitDied(e))
    this.watcher.onParser('spellInterruptSuccess', (e) => this.onInterrupt(e))
    this.watcher.onParser('spellDamage', (e) => this.onSpellDamage(e))
    this.watcher.onParser('damageDone', (e) => this.onDamageDone(e))
    this.watcher.onParser('spellHealAmount', (e) => this.onSpellHeal(e))
    this.watcher.onParser('spellCast', (e) => this.onSpellCast(e, false))
    this.watcher.onParser('spellCastStart', (e) => this.onSpellCast(e, true))
    this.watcher.onParser('buffChange', (e) => this.onBuffChange(e))
  }

  private bindRecorderEvents(): void {
    this.recorder.on('bufferStopped', ({ message }) => {
      // Closing WoW ends it too; the next game check sees that. Otherwise don't respawn
      // it in a loop if the helper keeps dying.
      this.standbyRetryAfterMs = Date.now() + STANDBY_RETRY_MS
      console.error('[MythicPlus] The pre-roll buffer stopped:', message)
      if (this.armed?.buffered === true) this.clearArmed()
    })
    this.recorder.on('unexpectedStop', ({ outputPath }) => {
      if (this.armed !== null && !this.armed.buffered) {
        console.error('[MythicPlus] Armed recording stopped unexpectedly')
        this.clearArmed()
        void discardFile(outputPath)
      }
      if (this.session === null) return
      console.error('[MythicPlus] Recorder stopped unexpectedly mid-key')
      this.clearTimers()
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: `Recording stopped unexpectedly. Raw file: ${outputPath}` })
    })
  }

  // ---------------------------------------------------------------------------
  // Key start / end
  // ---------------------------------------------------------------------------

  private onKeyStart(e: ChallengeModeStartEvent): void {
    this.beginSession({
      zoneName: e.zoneName,
      instanceId: e.instanceId,
      startedAt: e.timestamp,
      key: e,
      pull: null,
      label: `${e.zoneName} +${e.keystoneLevel}`,
      startEvent: { timestamp: 0, type: 'key-start', unit: `${e.zoneName} +${e.keystoneLevel}` }
    })
  }

  private onRaidPullStart(e: EncounterStartEvent, difficulty: RaidDifficulty): void {
    if (this.pullCountsInstanceId !== e.instanceId) {
      this.pullCounts.clear()
      this.pullCountsInstanceId = e.instanceId
    }
    const pullNumber = (this.pullCounts.get(e.encounterId) ?? 0) + 1
    this.pullCounts.set(e.encounterId, pullNumber)
    // Logging switched on after zoning in (the addon does that) leaves no ZONE_CHANGE, so
    // learn the raid from the pull; otherwise later pulls are never armed for
    if (this.zone?.instanceId !== e.instanceId) {
      this.zone = { instanceId: e.instanceId, zoneName: e.encounterName, difficultyId: e.difficultyId, timestamp: e.timestamp }
    }
    const zoneName = this.zone.zoneName
    const session = this.beginSession({
      zoneName,
      instanceId: e.instanceId,
      startedAt: e.timestamp,
      key: null,
      pull: { encounter: e, difficulty, pullNumber },
      label: e.encounterName,
      startEvent: { timestamp: 0, type: 'pull-start', unit: `${e.encounterName} pull ${pullNumber}` }
    })
    if (session !== null) {
      session.openEncounter = { encounterId: e.encounterId, name: e.encounterName, startRelSecs: 0 }
    }
  }

  private beginSession(start: {
    zoneName: string
    instanceId: number
    startedAt: Date
    key: ChallengeModeStartEvent | null
    pull: RaidPull | null
    label: string
    startEvent: TimelineEvent
  }): KeySession | null {
    // If we hold the recorder for a previous key it's ours to stop; if something else
    // holds it (test mode), leave it alone.
    const ownsRecorder = this.session !== null || this.armed !== null
    if (!ownsRecorder && this.recorder.isRecording()) {
      console.warn(`[MythicPlus] Recorder already busy (test mode), not recording ${start.label}`)
      return null
    }

    // A new key or pull while one is still open (reset and re-run, or a missed END):
    // save the old one as abandoned first.
    if (this.session !== null && !this.session.ending) {
      console.warn('[MythicPlus] New recording started while the previous one is still open: closing it as abandoned')
      this.finalize('abandoned', start.startedAt, null)
    }
    if (this.status === 'error') this.transitionTo('idle')
    this.cutPostRoll?.()

    // The session is installed synchronously: the watcher hands over log lines in
    // batches, so the first boss pull (or even the END) can arrive in the same tick.
    // Take over the recording armed on entering this instance, if there is one.
    const sameInstance = this.armed !== null && this.armed.instanceId === start.instanceId ? this.armed : null
    if (sameInstance !== null) this.clearArmed()
    else this.disarm()
    // A buffer isn't taken over: recorder.start() below opens a file from it
    const armed = sameInstance !== null && !sameInstance.buffered ? sameInstance : null
    const buffering = sameInstance?.buffered === true ? sameInstance.started : Promise.resolve(false)
    const rawPath = armed?.rawOutputPath ?? buildRawPath(this.options.rawRecordingsDir, start.zoneName, start.startedAt)
    // A standby buffer still starting is used once it's up
    const previousStop = Promise.all([this.finalizing, this.disarming, this.standbyStarting]).then(() => undefined)
    const session: KeySession = {
      zoneName: start.zoneName,
      instanceId: start.instanceId,
      startedAt: start.startedAt,
      key: start.key,
      pull: start.pull,
      rawOutputPath: rawPath,
      started: Promise.resolve(false),
      recordingStartedAt: null,
      timeline: [start.startEvent],
      encounters: [],
      openEncounter: null,
      roster: new Map(),
      selfGuid: null,
      recentDamageByGuid: new Map(),
      deathsByPlayer: new Map(),
      interruptsByPlayer: new Map(),
      dmgTakenByName: new Map(),
      dmgDoneByName: new Map(),
      healDoneByName: new Map(),
      coach: new CoachCollector(),
      abandonTimer: null,
      lastLogTimestamp: start.startedAt,
      lastLogWallMs: Date.now(),
      idleTimer: null,
      ending: false
    }
    session.started =
      armed !== null
        ? armed.started.then((ok) => {
            session.recordingStartedAt = armed.recordingStartedAt
            if (!ok) this.failSession(session, armed.failure ?? 'the armed recording did not start')
            return ok
          })
        : Promise.all([previousStop, buffering]).then(() => this.startRecorder(session))
    void session.started.then((ok) => {
      if (ok) void this.writeRawInfo(session)
    })
    session.idleTimer = setInterval(() => this.checkIdle(session), 30_000)
    this.session = session
    this.transitionTo('recording', start.label)
    return session
  }

  private async writeRawInfo(session: KeySession): Promise<void> {
    const pull = session.pull
    const info: RawRecordingInfo = {
      zoneName: session.zoneName,
      instanceId: session.instanceId,
      challengeModeId: session.key?.challengeModeId ?? 0,
      keystoneLevel: session.key?.keystoneLevel ?? 0,
      affixIds: session.key?.affixIds ?? [],
      keyStartedAt: session.startedAt.toISOString(),
      recordingStartedAt: (session.recordingStartedAt ?? session.startedAt).toISOString(),
      preRollSecs: this.preRollSecsFor(session),
      raid:
        pull !== null
          ? {
              encounterId: pull.encounter.encounterId,
              encounterName: pull.encounter.encounterName,
              difficulty: pull.difficulty,
              groupSize: pull.encounter.groupSize,
              pullNumber: pull.pullNumber
            }
          : undefined
    }
    try {
      await fs.writeFile(rawInfoPath(session.rawOutputPath), JSON.stringify(info))
    } catch (err) {
      console.error('[MythicPlus] Could not write the raw recording info:', err instanceof Error ? err.message : String(err))
    }
  }

  private async startRecorder(session: KeySession): Promise<boolean> {
    try {
      const firstFrameAt = await this.recorder.start(session.rawOutputPath, this.options.recorder)
      // When the file's first frame was captured: before now if it opens with buffered
      // footage, otherwise read AFTER the recorder confirms capture. Used for the trim offset.
      session.recordingStartedAt = firstFrameAt instanceof Date ? firstFrameAt : new Date()
      console.warn(`[MythicPlus] Recorder started: ${session.rawOutputPath}`)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MythicPlus] recorder.start() failed:', message)
      this.failSession(session, message)
      return false
    }
  }

  private failSession(session: KeySession, message: string): void {
    if (this.session === session) {
      this.clearTimers()
      this.session = null
    }
    this.transitionTo('error')
    this.emit('error', { message: `Failed to start recording: ${message}` })
  }

  // ---------------------------------------------------------------------------
  // Arming on dungeon entry (pre-roll)
  // ---------------------------------------------------------------------------

  private arm(instanceId: number, zoneName: string, timestamp: Date, forRaid: boolean, armedSinceMs = Date.now()): void {
    if (this.armed !== null || this.session !== null) return
    // Busy and not because of us: test mode has it.
    if (this.recorder.isRecording() && this.disarmsInFlight === 0) return
    if (this.canBuffer()) {
      this.armBuffer(instanceId, zoneName, forRaid)
      return
    }
    const armed: ArmedRecording = {
      buffered: false,
      instanceId,
      rawOutputPath: buildRawPath(this.options.rawRecordingsDir, zoneName, timestamp),
      started: Promise.resolve(false),
      recordingStartedAt: null,
      restartTimer: null,
      cancelled: false,
      failure: null,
      forRaid
    }
    const previousStop = Promise.all([this.finalizing, this.disarming])
    armed.started = previousStop.then(async () => {
      if (armed.cancelled) return false
      // Anything we were recording has stopped by now, so this is test mode — leave it be.
      if (this.recorder.isRecording()) {
        if (this.armed === armed) this.clearArmed()
        return false
      }
      try {
        await this.recorder.start(armed.rawOutputPath, this.options.recorder)
        armed.recordingStartedAt = new Date()
        console.warn(`[MythicPlus] Armed for a ${forRaid ? 'pull' : 'key'} in ${zoneName}: ${armed.rawOutputPath}`)
        return true
      } catch (err) {
        armed.failure = err instanceof Error ? err.message : String(err)
        console.error('[MythicPlus] Arming failed:', armed.failure)
        if (this.armed === armed) this.clearArmed()
        return false
      }
    })
    // Waiting around with no key: start over now and then so the file stays small, and
    // give up after a while (a Mythic 0, or a log that stopped before we saw the exit).
    const restartMs = (this.options.armedRestartSecs ?? MYTHIC_PLUS_ARMED_RESTART_SECS) * 1000
    armed.restartTimer = setTimeout(() => {
      if (this.armed !== armed) return
      this.disarm()
      // A raid can sit between pulls for hours, but not with the log silent (logged out,
      // or logging turned off before we saw the exit)
      const keepGoing = forRaid
        ? Date.now() - this.lastLogWallMs <= RAID_ARMED_QUIET_MAX_SECS * 1000
        : Date.now() - armedSinceMs + restartMs <= MYTHIC_PLUS_ARMED_MAX_SECS * 1000
      if (keepGoing) {
        this.arm(instanceId, zoneName, new Date(), forRaid, armedSinceMs)
      }
    }, restartMs)
    this.armed = armed
  }

  private canBuffer(): boolean {
    return this.recorder.startBuffer !== undefined && this.recorder.stopBuffer !== undefined
  }

  // Starts the recorder's rolling buffer. Nothing is written beyond the buffer until a
  // key or pull starts, so there's nothing to restart. For a key it gives up after the
  // same hour; in a raid it runs until we leave or the log goes quiet.
  private armBuffer(instanceId: number, zoneName: string, forRaid: boolean): void {
    const armed: ArmedRecording = {
      buffered: true,
      forRaid,
      instanceId,
      rawOutputPath: '',
      started: Promise.resolve(false),
      recordingStartedAt: null,
      restartTimer: null,
      cancelled: false,
      failure: null
    }
    const previousStop = Promise.all([this.finalizing, this.disarming, this.standbyStarting])
    armed.started = previousStop.then(async () => {
      if (armed.cancelled) return false
      // Anything we were recording has stopped by now, so this is test mode — leave it be.
      if (this.recorder.isRecording()) {
        if (this.armed === armed) this.clearArmed()
        return false
      }
      try {
        const bufferSecs = this.options.bufferSecs ?? PRE_ROLL_BUFFER_SECS
        // Still running after the last pull: keep it, it holds the run-in to the next one
        if (this.recorder.isBuffering?.() === true) return true
        await this.recorder.startBuffer?.(bufferSecs, this.options.recorder)
        console.warn(`[MythicPlus] Armed for a ${forRaid ? 'pull' : 'key'} in ${zoneName}: buffering the last ${bufferSecs}s`)
        return true
      } catch (err) {
        armed.failure = err instanceof Error ? err.message : String(err)
        console.error('[MythicPlus] Arming failed:', armed.failure)
        if (this.armed === armed) this.clearArmed()
        return false
      }
    })
    armed.restartTimer = forRaid
      ? setInterval(() => {
          // Logged out, or logging turned off before we saw the exit
          if (this.armed === armed && Date.now() - this.lastLogWallMs > RAID_ARMED_QUIET_MAX_SECS * 1000) this.disarm()
        }, RAID_QUIET_CHECK_MS)
      : setTimeout(() => {
          if (this.armed === armed) this.disarm()
        }, MYTHIC_PLUS_ARMED_MAX_SECS * 1000)
    this.armed = armed
  }

  // Ends the rolling buffer unless a key, a pull, an armed zone or the open game needs it
  private async stopBufferIfUnused(): Promise<void> {
    if (this.session !== null || this.armed !== null) return
    if (this.gameOpen && !this.quitting) return
    await this.stopBuffer()
  }

  private startGameChecks(): void {
    if (this.options.isGameRunning === undefined || !this.canBuffer() || this.gameCheckTimer !== null) return
    if (this.quitting) return
    this.gameCheckTimer = setInterval(() => void this.checkGame(), this.options.gameCheckMs ?? GAME_CHECK_MS)
    void this.checkGame()
  }

  // Polled: keeps the standby buffer up while the game is open, and ends it once it closes
  private async checkGame(): Promise<void> {
    const check = this.options.isGameRunning
    if (check === undefined || this.gameCheckInFlight || this.quitting) return
    this.gameCheckInFlight = true
    try {
      let running: boolean
      try {
        running = await check()
      } catch (err) {
        console.error('[MythicPlus] Checking whether WoW is running failed:', err instanceof Error ? err.message : String(err))
        return
      }
      // Switched off meanwhile
      if (this.quitting || this.gameCheckTimer === null) return
      if (running !== this.gameOpen) console.warn(`[MythicPlus] WoW ${running ? 'is open' : 'closed'}`)
      this.gameOpen = running
      if (running) this.startStandbyBuffer()
      else await this.stopBufferIfUnused()
    } finally {
      this.gameCheckInFlight = false
    }
  }

  private startStandbyBuffer(): void {
    if (this.standbyStartInFlight || this.quitting) return
    // Armed or recording: those start (or already use) the buffer themselves
    if (this.session !== null || this.armed !== null) return
    if (this.recorder.isBuffering?.() === true || this.recorder.isRecording()) return
    if (Date.now() < this.standbyRetryAfterMs) return
    this.standbyStartInFlight = true
    const previousStop = Promise.all([this.finalizing, this.disarming])
    this.standbyStarting = previousStop
      .then(async () => {
        // Something else took the recorder meanwhile (a key, a zone-in, test mode)
        if (this.session !== null || this.armed !== null || this.quitting || !this.gameOpen) return
        if (this.recorder.isBuffering?.() === true || this.recorder.isRecording()) return
        const bufferSecs = this.options.bufferSecs ?? PRE_ROLL_BUFFER_SECS
        try {
          await this.recorder.startBuffer?.(bufferSecs, this.options.recorder)
          console.warn(`[MythicPlus] WoW is open: buffering the last ${bufferSecs}s`)
        } catch (err) {
          this.standbyRetryAfterMs = Date.now() + STANDBY_RETRY_MS
          console.error('[MythicPlus] Starting the pre-roll buffer failed:', err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        this.standbyStartInFlight = false
      })
  }

  // Ends the rolling buffer, if the recorder has one running.
  private async stopBuffer(): Promise<void> {
    if (this.recorder.isBuffering?.() !== true) return
    try {
      await this.recorder.stopBuffer?.()
    } catch (err) {
      console.error('[MythicPlus] Stopping the pre-roll buffer failed:', err instanceof Error ? err.message : String(err))
    }
  }

  private clearArmed(): void {
    // Also clears the raid's setInterval
    if (this.armed?.restartTimer != null) clearTimeout(this.armed.restartTimer)
    this.armed = null
  }

  // Stops and deletes the armed recording (no key came).
  private disarm(): void {
    const armed = this.armed
    if (armed === null) return
    armed.cancelled = true
    this.clearArmed()
    const previous = this.disarming
    this.disarmsInFlight++
    this.disarming = previous.then(async () => {
      try {
        if (!(await armed.started)) return
        if (armed.buffered) {
          // A key that started meanwhile records from the buffer; leave it running then
          await this.stopBufferIfUnused()
          return
        }
        const path = await this.recorder.stop()
        await discardFile(path)
      } catch (err) {
        console.error('[MythicPlus] Stopping the armed recording failed:', err instanceof Error ? err.message : String(err))
      } finally {
        this.disarmsInFlight--
      }
    })
  }

  private onKeyEnd(e: ChallengeModeEndEvent): void {
    const session = this.session
    if (session === null || session.ending || session.key === null) return
    if (e.instanceId !== session.instanceId) return

    // An abandoned/reset key logs END with success=0 and no time.
    const outcome: MythicPlusOutcome = e.success
      ? 'completed'
      : e.totalTimeMs > 0
        ? 'depleted'
        : 'abandoned'

    this.closeOpenEncounter(e.timestamp, false)
    session.timeline.push({
      timestamp: this.relSecs(e.timestamp),
      type: 'key-end',
      unit: outcome === 'completed' ? 'Key completed' : outcome === 'depleted' ? 'Key depleted' : 'Key abandoned'
    })

    // Keep rolling briefly so the completion screen makes it into the video (a reset
    // has none, so it stops right away).
    const postRollSecs = outcome === 'abandoned' ? 0 : (this.options.postRollSecs ?? MYTHIC_PLUS_POST_ROLL_SECS)
    this.endWithPostRoll(session, outcome, e.timestamp, e, postRollSecs)
  }

  private onRaidPullEnd(session: KeySession, e: EncounterEndEvent): void {
    this.closeOpenEncounter(e.timestamp, e.success)
    const postRollSecs = this.options.raidPostRollSecs ?? RAID_POST_ROLL_SECS
    this.endWithPostRoll(session, e.success ? 'kill' : 'wipe', e.timestamp, e, postRollSecs)
  }

  // Marks the session as ending now so nothing else (zone change, another END) races
  // the post-roll.
  private endWithPostRoll(
    session: KeySession,
    outcome: SessionOutcome,
    endTimestamp: Date,
    endEvent: ChallengeModeEndEvent | EncounterEndEvent,
    postRollSecs: number
  ): void {
    session.ending = true
    this.clearTimers()
    const postRollStartedMs = Date.now()
    const postRoll = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, postRollSecs * 1000)
      this.cutPostRoll = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.finalizing = postRoll.then(() => {
      this.cutPostRoll = null
      return this.doFinalize(session, outcome, endTimestamp, endEvent, (Date.now() - postRollStartedMs) / 1000)
    })
  }

  // Immediate finalize (no post-roll) — abandon timeout or a new key starting.
  private finalize(outcome: SessionOutcome, endTimestamp: Date, endEvent: ChallengeModeEndEvent | null): void {
    const session = this.session
    if (session === null || session.ending) return
    session.ending = true
    this.clearTimers()
    this.closeOpenEncounter(endTimestamp, false)
    this.finalizing = this.doFinalize(session, outcome, endTimestamp, endEvent, 0)
  }

  private async doFinalize(
    session: KeySession,
    outcome: SessionOutcome,
    endTimestamp: Date,
    endEvent: ChallengeModeEndEvent | EncounterEndEvent | null,
    postRollSecs: number
  ): Promise<void> {
    // END can arrive before the recorder has finished starting (same log batch).
    if (!(await session.started)) return
    // Only report status for the key the UI is showing — a newer key may already be
    // recording while this one is being stopped.
    const isCurrent = (): boolean => this.session === session
    if (isCurrent()) this.transitionTo('processing', session.zoneName)

    let finalPath: string
    try {
      finalPath = await this.recorder.stop()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MythicPlus] recorder.stop() failed:', message)
      if (!isCurrent()) return
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: `Failed to stop recording: ${message}` })
      return
    }

    // Video t=0 is preRollSecs before the key start when the recorder was armed on
    // entering the dungeon (the trim drops anything earlier). Without arming it's when
    // the recorder came up, a few seconds after the key started because it's only
    // started once we *read* CHALLENGE_MODE_START. Either way shift everything so
    // timeline seconds line up with video seconds (a negative lead is pre-roll).
    const keyStartedAt = session.startedAt
    const recordingStartedAt = session.recordingStartedAt ?? keyStartedAt
    const preRollSecs = this.preRollSecsFor(session)
    const leadSecs = Math.max(-preRollSecs, (recordingStartedAt.getTime() - keyStartedAt.getTime()) / 1000)
    const videoStartedAt = new Date(keyStartedAt.getTime() + leadSecs * 1000)
    const shift = (t: number): number => Math.max(0, round2(t - leadSecs))

    const timeline = session.timeline.map((ev) => ({ ...ev, timestamp: shift(ev.timestamp) }))
    const encounters = session.encounters.map((enc) => ({ ...enc, start: shift(enc.start), end: shift(enc.end) }))
    const durationSecs = Math.max(
      1,
      round2((endTimestamp.getTime() - videoStartedAt.getTime()) / 1000 + postRollSecs)
    )

    const deathsByPlayer = Object.fromEntries(session.deathsByPlayer)
    const deathCount = Object.values(deathsByPlayer).reduce((a, b) => a + b, 0)
    const interruptsByPlayer = Object.fromEntries(session.interruptsByPlayer)
    let mythicPlus: MythicPlusInfo | undefined
    let raid: RaidInfo | undefined
    let won: boolean
    if (session.pull !== null) {
      const pullEnd = endEvent !== null && 'fightTimeMs' in endEvent ? endEvent : null
      // Anything that isn't an ENCOUNTER_END kill (left mid-pull, log stopped) is a wipe
      const raidOutcome: RaidOutcome = outcome === 'kill' ? 'kill' : 'wipe'
      won = raidOutcome === 'kill'
      raid = {
        instanceId: session.instanceId,
        encounterId: session.pull.encounter.encounterId,
        encounterName: session.pull.encounter.encounterName,
        difficulty: session.pull.difficulty,
        groupSize: session.pull.encounter.groupSize,
        outcome: raidOutcome,
        fightTimeMs: pullEnd?.fightTimeMs ?? 0,
        pullNumber: session.pull.pullNumber,
        deathCount,
        deathsByPlayer,
        interruptsByPlayer
      }
    } else {
      const key = session.key!
      const keyEnd = endEvent !== null && 'totalTimeMs' in endEvent ? endEvent : null
      const keyOutcome: MythicPlusOutcome = outcome === 'completed' || outcome === 'depleted' ? outcome : 'abandoned'
      won = keyOutcome === 'completed'
      mythicPlus = {
        instanceId: session.instanceId,
        challengeModeId: key.challengeModeId,
        keystoneLevel: key.keystoneLevel,
        affixIds: key.affixIds,
        outcome: keyOutcome,
        totalTimeMs: keyEnd?.totalTimeMs ?? 0,
        // A reset/abandoned END reports 0/0: that's "no score", not a score of 0.
        score:
          keyEnd?.dungeonScore !== undefined && keyEnd.overallRating !== undefined && keyEnd.overallRating > 0
            ? { dungeon: keyEnd.dungeonScore, overall: keyEnd.overallRating }
            : null,
        encounters,
        deathCount,
        deathsByPlayer,
        interruptsByPlayer
      }
    }

    const coach = session.coach.build(leadSecs, durationSecs)
    // Spec names for the party, from COMBATANT_INFO — the replay view colors and labels
    // players with these
    const knownSpecs: Record<string, string> = {}
    for (const p of coach.players) {
      const spec = p.specId !== null ? WOW_SPEC_ID_MAP[p.specId] : undefined
      if (spec !== undefined) knownSpecs[p.name] = spec.spec
    }

    // The recording player, from the unit the log flags as theirs
    const self = coach.players.find((p) => p.guid === session.selfGuid)
    const selfSpec = self?.specId != null ? WOW_SPEC_ID_MAP[self.specId] : undefined
    const selfName = session.selfGuid !== null ? (session.roster.get(session.selfGuid) ?? self?.name ?? '') : ''

    const event: ProcessingRequiredEvent = {
      rawPath: finalPath,
      zoneName: session.zoneName,
      result: won ? 'WIN' : 'LOSS',
      durationSecs,
      matchStartedAt: videoStartedAt,
      recordingStartedAt,
      timeline,
      knownSpecs,
      teamComp: [...session.roster.values()],
      player: { name: selfName, class: selfSpec?.class ?? '', spec: selfSpec?.spec ?? '' },
      playerDamageDone: Object.fromEntries(session.dmgDoneByName),
      playerDamageTaken: Object.fromEntries(session.dmgTakenByName),
      playerHealingDone: Object.fromEntries(session.healDoneByName),
      mythicPlus,
      raid,
      coach
    }

    if (isCurrent()) {
      this.session = null
      this.transitionTo('idle')
    }
    this.emit('processingRequired', event)
    // Still in the raid: arm again so the next pull has its pre-roll (from the buffer
    // that's still running)
    if (session.pull !== null && this.session === null && !this.quitting) this.armForZone()
    // A recording from the buffer leaves it running. After a key nothing needs it until
    // the next zone-in, unless a new key or pull took it over meanwhile, or the game is open.
    await this.stopBufferIfUnused()
  }

  // ---------------------------------------------------------------------------
  // Leaving the dungeon
  // ---------------------------------------------------------------------------

  private onZoneChanged(e: ZoneChangedEvent): void {
    if (this.armed !== null && this.armed.instanceId !== e.instanceId) this.disarm()
    // Only a fresh ZONE_CHANGE — the watcher's startup read can replay an old one.
    if (isRecentLogTime(e.timestamp)) {
      this.zone = e
      if (this.session === null) this.armForZone()
    }

    const session = this.session
    if (session === null || session.ending) return

    if (e.instanceId === session.instanceId) {
      // Back in the dungeon (e.g. after a disconnect) — keep going.
      this.clearAbandonTimer()
      return
    }

    if (session.abandonTimer !== null) return
    const timeoutSecs = this.options.abandonTimeoutSecs ?? MYTHIC_PLUS_ABANDON_TIMEOUT_SECS
    console.warn(`[MythicPlus] Left the dungeon mid-key — closing as abandoned in ${timeoutSecs}s unless you return`)
    session.abandonTimer = setTimeout(() => {
      session.abandonTimer = null
      this.finalize('abandoned', e.timestamp, null)
    }, timeoutSecs * 1000)
  }

  // Arms the recorder for the zone we're in, if it's one we record in.
  private armForZone(): void {
    const zone = this.zone
    const preRollSecs = this.options.preRollSecs ?? MYTHIC_PLUS_PRE_ROLL_SECS
    if (zone === null || preRollSecs <= 0) return
    if (MYTHIC_DUNGEON_DIFFICULTY_IDS.includes(zone.difficultyId)) {
      this.arm(zone.instanceId, zone.zoneName, zone.timestamp, false)
    } else if (this.raidDifficultyOf(zone.difficultyId) !== null) {
      this.arm(zone.instanceId, zone.zoneName, new Date(), true)
    }
  }

  // How much of the footage before the key or pull start is kept
  private preRollSecsFor(session: KeySession): number {
    const preRollSecs = this.options.preRollSecs ?? MYTHIC_PLUS_PRE_ROLL_SECS
    // 0 turns pre-roll off everywhere (tests)
    if (session.pull === null || preRollSecs <= 0) return preRollSecs
    return this.options.raidPreRollSecs ?? RAID_PRE_ROLL_SECS
  }

  private raidDifficultyOf(difficultyId: number): RaidDifficulty | null {
    const difficulty = RAID_DIFFICULTY_IDS[difficultyId]
    if (difficulty === undefined || !(this.options.raidDifficulties ?? []).includes(difficulty)) return null
    return difficulty
  }

  private clearAbandonTimer(): void {
    if (this.session?.abandonTimer != null) {
      clearTimeout(this.session.abandonTimer)
      this.session.abandonTimer = null
    }
  }

  private clearTimers(): void {
    this.clearAbandonTimer()
    if (this.session?.idleTimer != null) {
      clearInterval(this.session.idleTimer)
      this.session.idleTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Log going quiet
  // ---------------------------------------------------------------------------

  private onLogActivity(e: LogActivityEvent): void {
    this.lastLogWallMs = Date.now()
    const session = this.activeSession()
    if (session === null) return
    session.lastLogTimestamp = e.timestamp
    session.lastLogWallMs = Date.now()
  }

  // Seen on a real log: the key never got a CHALLENGE_MODE_END and no zone change —
  // the log just stopped. Without this the recorder would run until the app quits.
  private checkIdle(session: KeySession): void {
    if (this.session !== session || session.ending) return
    const timeoutMs = (this.options.idleTimeoutSecs ?? MYTHIC_PLUS_IDLE_TIMEOUT_SECS) * 1000
    if (Date.now() - session.lastLogWallMs < timeoutMs) return
    console.warn('[MythicPlus] Combat log went quiet mid-key — closing as abandoned')
    this.finalize('abandoned', session.lastLogTimestamp, null)
  }

  // ---------------------------------------------------------------------------
  // Bosses
  // ---------------------------------------------------------------------------

  private onEncounterStart(e: EncounterStartEvent): void {
    const raidDifficulty = this.raidDifficultyOf(e.difficultyId)
    if (raidDifficulty !== null && (this.session === null || this.session.pull !== null)) {
      // A pull replayed by the watcher's startup read is long over
      if (isRecentLogTime(e.timestamp)) this.onRaidPullStart(e, raidDifficulty)
      return
    }
    const session = this.activeSession()
    if (session === null || session.pull !== null) return
    // A second START without an END means we missed the END (e.g. a log flush gap) —
    // close the previous pull as a wipe rather than losing it.
    this.closeOpenEncounter(e.timestamp, false)
    session.openEncounter = {
      encounterId: e.encounterId,
      name: e.encounterName,
      startRelSecs: this.relSecs(e.timestamp)
    }
  }

  private onEncounterEnd(e: EncounterEndEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (session.pull !== null) {
      if (e.encounterId === session.pull.encounter.encounterId) this.onRaidPullEnd(session, e)
      return
    }
    if (session.openEncounter === null || session.openEncounter.encounterId !== e.encounterId) {
      // END for a pull we never saw start — record it from the fight time if we have one.
      const end = this.relSecs(e.timestamp)
      const start = e.fightTimeMs !== undefined ? Math.max(0, end - e.fightTimeMs / 1000) : end
      session.openEncounter = { encounterId: e.encounterId, name: e.encounterName, startRelSecs: start }
    }
    this.closeOpenEncounter(e.timestamp, e.success)
  }

  private closeOpenEncounter(timestamp: Date, success: boolean): void {
    const session = this.session
    if (session === null || session.openEncounter === null) return
    const open = session.openEncounter
    session.openEncounter = null

    const end = this.relSecs(timestamp)
    session.encounters.push({
      encounterId: open.encounterId,
      name: open.name,
      start: open.startRelSecs,
      end,
      success
    })
    session.timeline.push({
      timestamp: end,
      type: success ? 'boss-kill' : 'boss-wipe',
      unit: open.name,
      duration: round2(end - open.startRelSecs)
    })
  }

  // ---------------------------------------------------------------------------
  // Party events
  // ---------------------------------------------------------------------------

  private onCombatantInfo(e: CombatantInfoEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (e.playerName) session.roster.set(e.playerGuid, e.playerName)
    else if (!session.roster.has(e.playerGuid)) session.roster.set(e.playerGuid, '')
    session.coach.setCombatant(e.playerGuid, e.playerName, e.specId, e.talents, e.gear)
  }

  private onUnitDied(e: UnitDiedEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (e.unconscious) return // feign death, Ankh, etc.
    if (!e.unitGuid.startsWith('Player-') || !isPartyPlayer(e.destFlags)) return

    this.learnPartyMember(e.unitGuid, e.unitName)
    const relSecs = this.relSecs(e.timestamp)
    session.deathsByPlayer.set(e.unitName, (session.deathsByPlayer.get(e.unitName) ?? 0) + 1)
    session.coach.addDeath(e.unitGuid, e.unitName, relSecs)

    const hits = session.recentDamageByGuid.get(e.unitGuid) ?? []
    const deathSummary = hits
      .filter((h) => relSecs - h.relSecs <= DEATH_RECAP_WINDOW_SECS)
      .map((h) => ({ ...h, relSecs: round2(h.relSecs - relSecs) }))
    session.recentDamageByGuid.delete(e.unitGuid)

    session.timeline.push({
      timestamp: relSecs,
      type: 'death-player',
      unit: e.unitName,
      target: 'player',
      deathSummary: deathSummary.length > 0 ? deathSummary : undefined
    })
  }

  private onInterrupt(e: SpellInterruptSuccessEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (!isPartyPlayer(e.casterFlags) && !session.roster.has(e.casterGuid)) return

    session.interruptsByPlayer.set(e.casterName, (session.interruptsByPlayer.get(e.casterName) ?? 0) + 1)
    session.timeline.push({
      timestamp: this.relSecs(e.timestamp),
      type: 'interrupt',
      spellId: e.spellId,
      spellName: e.spellName,
      casterName: e.casterName,
      targetName: e.targetName,
      target: 'enemy',
      isSuccessful: true,
      interruptedSpell: e.interruptedSpellName
    })
  }

  private onSpellDamage(e: SpellDamageEvent): void {
    const session = this.activeSession()
    if (session === null) return
    this.noteSelf(session, e.casterGuid, e.casterFlags)
    this.noteSelf(session, e.targetGuid, e.targetFlags ?? 0)

    if (e.casterGuid.startsWith('Player-') && isPartyPlayer(e.casterFlags)) {
      this.learnPartyMember(e.casterGuid, e.casterName)
    }
    if (e.targetGuid.startsWith('Player-') && isPartyPlayer(e.targetFlags ?? 0)) {
      this.learnPartyMember(e.targetGuid, e.targetName)
    }

    if (!session.roster.has(e.targetGuid)) return
    if (e.targetName) {
      session.dmgTakenByName.set(e.targetName, (session.dmgTakenByName.get(e.targetName) ?? 0) + e.amount)
    }

    // Sliding death-recap window per party member. Hits arrive in time order, so trim
    // from the front rather than re-filtering the whole array on every hit (M+ logs are
    // busy).
    const relSecs = this.relSecs(e.timestamp)
    const hits = session.recentDamageByGuid.get(e.targetGuid) ?? []
    hits.push({
      relSecs,
      spellId: e.spellId,
      spellName: e.spellName,
      amount: e.amount,
      casterName: e.casterName || undefined,
      isCritical: e.isCritical
    })
    while (hits.length > 0 && relSecs - hits[0]!.relSecs > DEATH_RECAP_WINDOW_SECS) hits.shift()
    session.recentDamageByGuid.set(e.targetGuid, hits)
  }

  private onSpellHeal(e: SpellHealAmountEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (!session.roster.has(e.casterGuid)) return
    // Effective healing, like Details!: overhealing doesn't count toward HPS
    const effective = e.amount - (e.overhealing ?? 0)
    if (effective <= 0) return
    session.healDoneByName.set(e.casterName, (session.healDoneByName.get(e.casterName) ?? 0) + effective)
    session.coach.addHealing(e.casterGuid, e.casterName, effective, this.relSecs(e.timestamp))
  }

  private onSpellCast(e: SpellCastEvent, isStart: boolean): void {
    const session = this.activeSession()
    if (session === null) return
    this.noteSelf(session, e.casterGuid, e.casterFlags)
    if (!session.roster.has(e.casterGuid)) {
      if (!isPartyPlayer(e.casterFlags)) return
      this.learnPartyMember(e.casterGuid, e.casterName)
    }
    const relSecs = this.relSecs(e.timestamp)
    if (isStart) session.coach.addCastStart(e.casterGuid, e.casterName, relSecs)
    else session.coach.addCast(e.casterGuid, e.casterName, e.spellId, e.spellName, relSecs)
  }

  private onBuffChange(e: BuffChangeEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (e.casterGuid !== e.targetGuid || !session.roster.has(e.targetGuid)) return
    session.coach.addBuff(e.targetGuid, e.spellId, e.spellName, e.applied, this.relSecs(e.timestamp))
  }

  private onDamageDone(e: DamageDoneEvent): void {
    const session = this.activeSession()
    if (session === null || !e.casterName) return
    this.noteSelf(session, e.casterGuid, e.casterFlags)
    if (!session.roster.has(e.casterGuid)) {
      if (!isPartyPlayer(e.casterFlags)) return
      this.learnPartyMember(e.casterGuid, e.casterName)
    }
    session.dmgDoneByName.set(e.casterName, (session.dmgDoneByName.get(e.casterName) ?? 0) + e.amount)
    session.coach.addDamage(e.casterGuid, e.casterName, e.amount, this.relSecs(e.timestamp))
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private activeSession(): KeySession | null {
    const session = this.session
    if (session === null || session.ending) return null
    return session
  }

  private learnPartyMember(guid: string, name: string): void {
    if (this.session === null || !name) return
    this.session.roster.set(guid, name)
  }

  private noteSelf(session: KeySession, guid: string, flags: number): void {
    if (session.selfGuid === null && isLocalPlayer(guid, flags)) session.selfGuid = guid
  }

  // Seconds since the key or pull started (log time). Re-based to video time in doFinalize.
  private relSecs(timestamp: Date): number {
    if (this.session === null) return 0
    return Math.max(0, round2((timestamp.getTime() - this.session.startedAt.getTime()) / 1000))
  }

  private transitionTo(status: RecorderStatus, zone?: string): void {
    const prev = this.status
    this.status = status
    console.warn(`[MythicPlus] ${prev} → ${status}` + (zone !== undefined ? ` (${zone})` : ''))
    this.emit('statusChanged', { status, zone })
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isRecentLogTime(timestamp: Date): boolean {
  return Math.abs(Date.now() - timestamp.getTime()) <= MYTHIC_PLUS_ARM_MAX_LOG_AGE_SECS * 1000
}

function buildRawPath(dir: string, zone: string, startedAt: Date): string {
  const safeZone = zone.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const safeTs = startedAt.toISOString().replace(/[^0-9T]/g, '').slice(0, 15)
  return join(dir, `raw_mplus_${safeZone}_${safeTs}.mp4`)
}

async function discardFile(path: string): Promise<void> {
  await fs.rm(path, { force: true }).catch(() => undefined)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
