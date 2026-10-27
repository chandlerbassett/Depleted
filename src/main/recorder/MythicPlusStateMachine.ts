// Mythic+ recording state machine: idle → recording → processing → idle.
//
// Runs alongside RecorderStateMachine (arena) and shares the same WindowCaptureRecorder.
// The two never overlap in practice — you can't be in an arena and a keystone at once —
// but each checks recorder.isRecording() before starting so neither can clobber the other.
//
// State transitions:
//   idle       → recording  : challengeModeStart — recorder.start() is called here
//   recording  → processing : challengeModeEnd (after MYTHIC_PLUS_POST_ROLL_SECS), or
//                             MYTHIC_PLUS_ABANDON_TIMEOUT_SECS after leaving the dungeon,
//                             or a new challengeModeStart while a key is still open
//   processing → idle       : recorder stopped, processingRequired emitted
//   any        → error      : recorder crashes or start/stop fails
//
// Unlike arena, nothing is aborted on zone exit: a key is 30+ minutes of footage, so an
// abandoned key is still saved (outcome 'abandoned') rather than thrown away.

import { EventEmitter } from 'events'
import { join } from 'path'
import type {
  DeathHit,
  MythicPlusEncounter,
  MythicPlusInfo,
  MythicPlusOutcome,
  RecorderStatus,
  TimelineEvent
} from '@shared/ipc.types'
import {
  DEATH_RECAP_WINDOW_SECS,
  MYTHIC_PLUS_ABANDON_TIMEOUT_SECS,
  MYTHIC_PLUS_POST_ROLL_SECS
} from '@shared/constants'
import type { CombatLogWatcher } from '../combatlog/CombatLogWatcher'
import type {
  ChallengeModeEndEvent,
  ChallengeModeStartEvent,
  CombatantInfoEvent,
  EncounterEndEvent,
  EncounterStartEvent,
  SpellDamageEvent,
  SpellHealAmountEvent,
  SpellInterruptSuccessEvent,
  UnitDiedEvent,
  ZoneChangedEvent
} from '../combatlog/CombatLogParser'
import type { RecorderOptions, WindowCaptureRecorder } from './WindowCaptureRecorder'
import type { ProcessingRequiredEvent, StateMachineEventMap } from './RecorderStateMachine'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MythicPlusStateMachineOptions {
  // Directory for raw (untrimmed) recordings before post-processing
  rawRecordingsDir: string
  // Options forwarded to WindowCaptureRecorder.start()
  recorder?: RecorderOptions
  // Overridable for tests
  postRollSecs?: number
  abandonTimeoutSecs?: number
}

// Unit flag bits (COMBATLOG_OBJECT_*) used to pick out the local party.
const UNIT_FLAG_AFFILIATION_MINE = 0x1
const UNIT_FLAG_AFFILIATION_PARTY = 0x2
const UNIT_FLAG_TYPE_PLAYER = 0x400

function isPartyPlayer(flags: number): boolean {
  return (
    (flags & UNIT_FLAG_TYPE_PLAYER) !== 0 &&
    (flags & (UNIT_FLAG_AFFILIATION_MINE | UNIT_FLAG_AFFILIATION_PARTY)) !== 0
  )
}

interface OpenEncounter {
  encounterId: number
  name: string
  startRelSecs: number
}

interface KeySession {
  start: ChallengeModeStartEvent
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
  recentDamageByGuid: Map<string, DeathHit[]>
  deathsByPlayer: Map<string, number>
  interruptsByPlayer: Map<string, number>
  dmgTakenByName: Map<string, number>
  healDoneByName: Map<string, number>
  abandonTimer: ReturnType<typeof setTimeout> | null
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
  private readonly watcher: CombatLogWatcher
  private readonly recorder: WindowCaptureRecorder
  private options: MythicPlusStateMachineOptions

  constructor(
    watcher: CombatLogWatcher,
    recorder: WindowCaptureRecorder,
    options: MythicPlusStateMachineOptions
  ) {
    super()
    this.watcher = watcher
    this.recorder = recorder
    this.options = options
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
    this.watcher.onParser('combatantInfo', (e) => this.onCombatantInfo(e))
    this.watcher.onParser('unitDied', (e) => this.onUnitDied(e))
    this.watcher.onParser('spellInterruptSuccess', (e) => this.onInterrupt(e))
    this.watcher.onParser('spellDamage', (e) => this.onSpellDamage(e))
    this.watcher.onParser('spellHealAmount', (e) => this.onSpellHeal(e))
  }

  private bindRecorderEvents(): void {
    this.recorder.on('unexpectedStop', ({ outputPath }) => {
      if (this.session === null) return
      console.error('[MythicPlus] Recorder stopped unexpectedly mid-key')
      this.clearAbandonTimer()
      this.session = null
      this.transitionTo('error')
      this.emit('error', { message: `Recording stopped unexpectedly. Raw file: ${outputPath}` })
    })
  }

  // ---------------------------------------------------------------------------
  // Key start / end
  // ---------------------------------------------------------------------------

  private onKeyStart(e: ChallengeModeStartEvent): void {
    // If we hold the recorder for a previous key it's ours to stop; if something else
    // holds it (arena, test mode), leave it alone.
    const ownsRecorder = this.session !== null
    if (!ownsRecorder && this.recorder.isRecording()) {
      console.warn('[MythicPlus] Recorder already busy (arena or test mode) — not recording this key')
      return
    }

    // A new key while one is still open (reset and re-run, or a missed END): save the
    // old one as abandoned first.
    if (this.session !== null && !this.session.ending) {
      console.warn('[MythicPlus] New key started while previous key still open — closing it as abandoned')
      this.finalize('abandoned', e.timestamp, null)
    }
    if (this.status === 'error') this.transitionTo('idle')

    // The session is installed synchronously: the watcher hands over log lines in
    // batches, so the first boss pull (or even the END) can arrive in the same tick.
    const rawPath = buildRawPath(this.options.rawRecordingsDir, e.zoneName, e.timestamp)
    const previousStop = this.finalizing
    const session: KeySession = {
      start: e,
      rawOutputPath: rawPath,
      started: Promise.resolve(false),
      recordingStartedAt: null,
      timeline: [{ timestamp: 0, type: 'key-start', unit: `${e.zoneName} +${e.keystoneLevel}` }],
      encounters: [],
      openEncounter: null,
      roster: new Map(),
      recentDamageByGuid: new Map(),
      deathsByPlayer: new Map(),
      interruptsByPlayer: new Map(),
      dmgTakenByName: new Map(),
      healDoneByName: new Map(),
      abandonTimer: null,
      ending: false
    }
    session.started = previousStop.then(() => this.startRecorder(session))
    this.session = session
    this.transitionTo('recording', `${e.zoneName} +${e.keystoneLevel}`)
  }

  private async startRecorder(session: KeySession): Promise<boolean> {
    try {
      await this.recorder.start(session.rawOutputPath, this.options.recorder)
      // Set AFTER the recorder confirms capture — used for the trim offset.
      session.recordingStartedAt = new Date()
      console.warn(`[MythicPlus] Recorder started: ${session.rawOutputPath}`)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[MythicPlus] recorder.start() failed:', message)
      if (this.session === session) {
        this.clearAbandonTimer()
        this.session = null
      }
      this.transitionTo('error')
      this.emit('error', { message: `Failed to start recording: ${message}` })
      return false
    }
  }

  private onKeyEnd(e: ChallengeModeEndEvent): void {
    const session = this.session
    if (session === null || session.ending) return
    if (e.instanceId !== session.start.instanceId) return

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

    // Keep rolling briefly so the completion screen makes it into the video. Mark the
    // session as ending now so nothing else (zone change, another END) races this.
    session.ending = true
    this.clearAbandonTimer()
    const postRollMs = (this.options.postRollSecs ?? MYTHIC_PLUS_POST_ROLL_SECS) * 1000
    this.finalizing = sleep(postRollMs).then(() =>
      this.doFinalize(session, outcome, e.timestamp, e, postRollMs / 1000)
    )
  }

  // Immediate finalize (no post-roll) — abandon timeout or a new key starting.
  private finalize(outcome: MythicPlusOutcome, endTimestamp: Date, endEvent: ChallengeModeEndEvent | null): void {
    const session = this.session
    if (session === null || session.ending) return
    session.ending = true
    this.clearAbandonTimer()
    this.closeOpenEncounter(endTimestamp, false)
    this.finalizing = this.doFinalize(session, outcome, endTimestamp, endEvent, 0)
  }

  private async doFinalize(
    session: KeySession,
    outcome: MythicPlusOutcome,
    endTimestamp: Date,
    endEvent: ChallengeModeEndEvent | null,
    postRollSecs: number
  ): Promise<void> {
    // END can arrive before the recorder has finished starting (same log batch).
    if (!(await session.started)) return
    // Only report status for the key the UI is showing — a newer key may already be
    // recording while this one is being stopped.
    const isCurrent = (): boolean => this.session === session
    if (isCurrent()) this.transitionTo('processing', session.start.zoneName)

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

    // Video t=0 is the key start, unless the recorder came up after it (it's only
    // started once we *read* CHALLENGE_MODE_START, which can be a few seconds late).
    // In that case shift everything so timeline seconds still line up with video seconds.
    const keyStartedAt = session.start.timestamp
    const recordingStartedAt = session.recordingStartedAt ?? keyStartedAt
    const leadSecs = Math.max(0, (recordingStartedAt.getTime() - keyStartedAt.getTime()) / 1000)
    const videoStartedAt = new Date(keyStartedAt.getTime() + leadSecs * 1000)
    const shift = (t: number): number => Math.max(0, round2(t - leadSecs))

    const timeline = session.timeline.map((ev) => ({ ...ev, timestamp: shift(ev.timestamp) }))
    const encounters = session.encounters.map((enc) => ({ ...enc, start: shift(enc.start), end: shift(enc.end) }))
    const durationSecs = Math.max(
      1,
      round2((endTimestamp.getTime() - videoStartedAt.getTime()) / 1000 + postRollSecs)
    )

    const deathsByPlayer = Object.fromEntries(session.deathsByPlayer)
    const mythicPlus: MythicPlusInfo = {
      instanceId: session.start.instanceId,
      challengeModeId: session.start.challengeModeId,
      keystoneLevel: session.start.keystoneLevel,
      affixIds: session.start.affixIds,
      outcome,
      totalTimeMs: endEvent?.totalTimeMs ?? 0,
      rating:
        endEvent?.oldRating !== undefined && endEvent.newRating !== undefined
          ? { before: endEvent.oldRating, after: endEvent.newRating }
          : null,
      encounters,
      deathCount: Object.values(deathsByPlayer).reduce((a, b) => a + b, 0),
      deathsByPlayer,
      interruptsByPlayer: Object.fromEntries(session.interruptsByPlayer)
    }

    const event: ProcessingRequiredEvent = {
      rawPath: finalPath,
      zoneName: session.start.zoneName,
      bracket: 'mythic-plus',
      result: outcome === 'completed' ? 'WIN' : 'LOSS',
      durationSecs,
      matchStartedAt: videoStartedAt,
      recordingStartedAt,
      timeline,
      knownSpecs: {},
      healerNames: [],
      teamComp: [...session.roster.values()],
      enemyComp: [],
      playerRatings: {},
      playerAbsorb: {},
      // The parser only emits damage with a player target (an arena-era filter), so
      // damage done to mobs isn't available yet — left empty until that's opened up.
      playerDamageDone: {},
      playerDamageTaken: Object.fromEntries(session.dmgTakenByName),
      playerHealingDone: Object.fromEntries(session.healDoneByName),
      detectedMistakes: [],
      teamDmgBySecond: [],
      enemyDmgBySecond: [],
      teamHealBySecond: [],
      enemyHealBySecond: [],
      ratingBefore: mythicPlus.rating?.before,
      ratingAfter: mythicPlus.rating?.after,
      mythicPlus
    }

    if (isCurrent()) {
      this.session = null
      this.transitionTo('idle')
    }
    this.emit('processingRequired', event)
  }

  // ---------------------------------------------------------------------------
  // Leaving the dungeon
  // ---------------------------------------------------------------------------

  private onZoneChanged(e: ZoneChangedEvent): void {
    const session = this.session
    if (session === null || session.ending) return

    if (e.instanceId === session.start.instanceId) {
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

  private clearAbandonTimer(): void {
    if (this.session?.abandonTimer != null) {
      clearTimeout(this.session.abandonTimer)
      this.session.abandonTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Bosses
  // ---------------------------------------------------------------------------

  private onEncounterStart(e: EncounterStartEvent): void {
    const session = this.activeSession()
    if (session === null) return
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
  }

  private onUnitDied(e: UnitDiedEvent): void {
    const session = this.activeSession()
    if (session === null) return
    if (e.unconscious) return // feign death, Ankh, etc.
    if (!e.unitGuid.startsWith('Player-') || !isPartyPlayer(e.destFlags)) return

    this.learnPartyMember(e.unitGuid, e.unitName)
    const relSecs = this.relSecs(e.timestamp)
    session.deathsByPlayer.set(e.unitName, (session.deathsByPlayer.get(e.unitName) ?? 0) + 1)

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
    // far busier than arena).
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
    session.healDoneByName.set(e.casterName, (session.healDoneByName.get(e.casterName) ?? 0) + e.amount)
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

  // Seconds since the key started (log time). Re-based to video time in doFinalize.
  private relSecs(timestamp: Date): number {
    if (this.session === null) return 0
    return Math.max(0, round2((timestamp.getTime() - this.session.start.timestamp.getTime()) / 1000))
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

function buildRawPath(dir: string, zone: string, startedAt: Date): string {
  const safeZone = zone.replace(/[^a-z0-9]/gi, '-').toLowerCase()
  const safeTs = startedAt.toISOString().replace(/[^0-9T]/g, '').slice(0, 15)
  return join(dir, `raw_mplus_${safeZone}_${safeTs}.mp4`)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
