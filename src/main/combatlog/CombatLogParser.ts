// Parses WoW combat log lines and emits typed arena and Mythic+ events.
// Line format: "M/D/YYYY HH:MM:SS.mmm-4  EVENT_TYPE,field1,field2,..." (see parseWowTimestamp)
// Two spaces separate the timestamp from the event data.
//
// IMPORTANT: Field indices for ARENA_MATCH_STATS must be verified against
// each WoW patch's combat log format. See STATS_FIELD_* constants below.

import { EventEmitter } from 'events'
import type { ArenaBracket, ArenaResult } from '@shared/ipc.types'
import {
  ARENA_ZONE_IDS,
  ARENA_ZONE_NAMES,
  BRACKET_FIELD_MAP,
  SOLO_SHUFFLE_ROUNDS_PER_SESSION,
  SPELL_IDS_CC,
  SPELL_IDS_DEFENSIVE,
  SPELL_IDS_OFFENSIVE,
  SPELL_IDS_INTERRUPT,
  SPELL_IDS_CC_BREAK,
  SPELL_IDS_TRINKET,
  SPELL_IDS_IMMUNITY
} from '@shared/constants'

// ---------------------------------------------------------------------------
// ARENA_MATCH_STATS field indices (0-indexed, after the event type field).
// Verify these against the active patch's combat log format.
// Approximate layout: GUID, name, realm, teamIndex, teamName, score, ..., ratingBefore, ratingAfter
// ---------------------------------------------------------------------------
const STATS_FIELD_PLAYER_GUID = 0
const STATS_FIELD_PLAYER_NAME = 1
const STATS_FIELD_TEAM = 3        // 0 = local player's team, 1 = enemy — verify per patch
const STATS_FIELD_RATING_BEFORE = 13
const STATS_FIELD_RATING_AFTER = 14

// ---------------------------------------------------------------------------
// ZONE_CHANGE field indices
// ---------------------------------------------------------------------------
const ZONE_FIELD_INSTANCE_ID = 0
const ZONE_FIELD_ZONE_NAME = 1

// ---------------------------------------------------------------------------
// Mythic+ / encounter field indices (0-indexed, after the event type field)
//   CHALLENGE_MODE_START,"zoneName",instanceID,challengeModeID,keystoneLevel,[affixIDs]
//   CHALLENGE_MODE_END,instanceID,success,keystoneLevel,totalTimeMs[,oldRating,newRating]
//   ENCOUNTER_START,encounterID,"name",difficultyID,groupSize,instanceID
//   ENCOUNTER_END,encounterID,"name",difficultyID,groupSize,success[,fightTimeMs]
// Verify against a real Midnight M+ log — trailing fields have changed across patches.
// ---------------------------------------------------------------------------
const CM_START_FIELD_ZONE_NAME = 0
const CM_START_FIELD_INSTANCE_ID = 1
const CM_START_FIELD_CHALLENGE_MODE_ID = 2
const CM_START_FIELD_KEYSTONE_LEVEL = 3
const CM_START_FIELD_AFFIXES = 4

const CM_END_FIELD_INSTANCE_ID = 0
const CM_END_FIELD_SUCCESS = 1
const CM_END_FIELD_KEYSTONE_LEVEL = 2
const CM_END_FIELD_TOTAL_TIME_MS = 3
const CM_END_FIELD_OLD_RATING = 4
const CM_END_FIELD_NEW_RATING = 5

const ENCOUNTER_FIELD_ID = 0
const ENCOUNTER_FIELD_NAME = 1
const ENCOUNTER_FIELD_DIFFICULTY_ID = 2
const ENCOUNTER_FIELD_GROUP_SIZE = 3
const ENCOUNTER_START_FIELD_INSTANCE_ID = 4
const ENCOUNTER_END_FIELD_SUCCESS = 4
const ENCOUNTER_END_FIELD_FIGHT_TIME_MS = 5

// ---------------------------------------------------------------------------
// ARENA_MATCH_START field indices
// ---------------------------------------------------------------------------
const MATCH_START_FIELD_INSTANCE_ID = 0
const MATCH_START_FIELD_BRACKET = 2
// Field 3: which team the logging player is on (0 or 1). Used to derive WIN/LOSS from
// ARENA_MATCH_END's winningTeam, since the logging player is not always on team 0.
const MATCH_START_FIELD_LOCAL_TEAM = 3

// ---------------------------------------------------------------------------
// COMBATANT_INFO field indices (simple prefix fields — before the bracket sections)
// ---------------------------------------------------------------------------
const COMBATANT_FIELD_GUID = 0
const COMBATANT_FIELD_TEAM = 1  // 0 = enemy team, 1 = local player's team (matches localTeam)

// ---------------------------------------------------------------------------
// ARENA_MATCH_END field indices
// ---------------------------------------------------------------------------
const MATCH_END_FIELD_WINNING_TEAM = 0
const MATCH_END_FIELD_DURATION = 1

// ---------------------------------------------------------------------------
// SPELL_CAST_SUCCESS / SPELL_HEAL field indices
// Standard WoW prefix layout: srcGUID, srcName, srcFlags, srcRaidFlags,
// dstGUID, dstName, dstFlags, dstRaidFlags, spellId, spellName, spellSchool
// ---------------------------------------------------------------------------
const SPELL_FIELD_CASTER_GUID = 0
const SPELL_FIELD_CASTER_NAME = 1
const SPELL_FIELD_CASTER_FLAGS = 2
const SPELL_FIELD_TARGET_GUID = 4
const SPELL_FIELD_TARGET_NAME = 5
const SPELL_FIELD_TARGET_FLAGS = 6
const SPELL_FIELD_SPELL_ID = 8
const SPELL_FIELD_SPELL_NAME = 9
// Advanced Combat Logging (required by this app — see README) inserts a ~17-field
// "advanced" metadata block (unitGUID, ownerGUID, currentHP, maxHP, attackPower,
// spellPower, armor, absorb, powerType, currentPower, maxPower, powerCost, x, y,
// uiMapID, facing, level) between the spell prefix and the damage/heal suffix. That
// means the amount is NOT at a fixed forward offset from the prefix — a previous
// version of this parser assumed it was (SPELL_SUFFIX_AMOUNT = 11, SWING_DAMAGE_AMOUNT
// = 8), which actually pointed at the advanced block's unitGUID field, a string that
// parseInt() silently turns into NaN. That NaN failed the `amount > 0` check in every
// handler below, meaning damage/healing were silently dropped for every recording made
// with ACL on — exactly the setting this app requires.
//
// Verified against ~2000 real Midnight combat log lines of each event type: the field
// COUNT is exactly stable per event type (SPELL_DAMAGE/SPELL_PERIODIC_DAMAGE always 41
// fields, SWING_DAMAGE always 37, SPELL_HEAL/SPELL_PERIODIC_HEAL always 35), so the
// amount is reliable at a fixed offset from the END of the fields array instead — the
// damage/heal suffix format itself doesn't change regardless of what's inserted before it.
//
// Note: the advanced block's unitGUID/ownerGUID describe the DESTINATION unit (whose
// HP/power is being tracked), not the source/caster — verified against real logs, e.g.
// a Healing Stream Totem's SPELL_HEAL always has unitGUID == the heal's targetGuid.
// That means this block can't be used to resolve a pet/totem CASTER back to its owning
// player — see resolveEffectiveCaster / summonOwners below, which uses SPELL_SUMMON
// instead (the log event that announces "this player just created this pet/totem GUID").
function parseSpellDamageAmount(fields: string[]): number {
  return parseInt(fields[fields.length - 11] ?? '', 10)
}
function parseSwingDamageAmount(fields: string[]): number {
  return parseInt(fields[fields.length - 10] ?? '', 10)
}
function parseHealAmount(fields: string[]): number {
  return parseInt(fields[fields.length - 5] ?? '', 10)
}

// WoW's combat log writes the literal string "nil" for fields it can't resolve a real
// value for (e.g. a caster whose original identity is no longer trackable, commonly
// seen on some DoT ticks) — normalize it to '' here so every downstream truthiness
// check (`if (e.casterName)`) treats it the same as "no name", instead of a phantom
// "nil" player showing up in meters/death recaps.
function sanitizeName(raw: string | undefined): string {
  return raw === undefined || raw === 'nil' ? '' : raw
}

// Critical-hit flag: "1" when true, "nil" otherwise — verified against real log lines.
// SPELL_DAMAGE/SPELL_PERIODIC_DAMAGE end in an extra AOE/ST marker that SWING_DAMAGE
// doesn't have, shifting the offset by one.
function parseSpellDamageIsCritical(fields: string[]): boolean {
  return fields[fields.length - 4] === '1'
}
function parseSwingDamageIsCritical(fields: string[]): boolean {
  return fields[fields.length - 3] === '1'
}


// ---------------------------------------------------------------------------
// SPELL_ABSORBED field indices — verified against a real Midnight combat log.
// Layout: attackerPrefix(4), victimPrefix(4), damagingSpellId/Name/School(3),
//         absorbCasterPrefix(4), absorbSpellId/Name/School(3), amount, extraAmount, critical
// e.g. "SPELL_ABSORBED,<attacker>,<victim>,88625,"Holy Word: Chastise",0x2,
//       <shieldCaster>,1246768,"Power Word: Shield",0x2,20199,24545,nil"
// ---------------------------------------------------------------------------
const ABSORBED_FIELD_CASTER_GUID = 11
const ABSORBED_FIELD_CASTER_NAME = 12
const ABSORBED_FIELD_AMOUNT = 18

// ---------------------------------------------------------------------------
// SPELL_INTERRUPT field indices
// Same prefix layout as SPELL_CAST_SUCCESS, followed by:
//   interruptSpellId, interruptSpellName, school, interruptedSpellId, interruptedSpellName, interruptedSchool
// ---------------------------------------------------------------------------
const INTERRUPT_FIELD_SPELL_ID = 8
const INTERRUPT_FIELD_SPELL_NAME = 9
const INTERRUPT_FIELD_INTERRUPTED_SPELL_ID = 11
const INTERRUPT_FIELD_INTERRUPTED_SPELL_NAME = 12

// Precognition buff — applied when an interrupt is used on a player who wasn't casting
// (or was immune). Used to detect bad/wasted interrupts.
const PRECOGNITION_SPELL_ID = 377362

// ---------------------------------------------------------------------------
// UNIT_DIED field indices
// srcGUID, srcName, srcFlags, srcRaidFlags, destGUID, destName, destFlags, destRaidFlags, unconscious
// ---------------------------------------------------------------------------
const UNIT_DIED_FIELD_DEST_GUID = 4
const UNIT_DIED_FIELD_DEST_NAME = 5
const UNIT_DIED_FIELD_DEST_FLAGS = 6

// ---------------------------------------------------------------------------
// UNIT_HEALTH field indices (Advanced Combat Logging only)
// srcGUID, srcName, srcFlags, srcRaidFlags, destGUID, destName, destFlags, destRaidFlags, hp, maxHp
// ---------------------------------------------------------------------------
const UNIT_HEALTH_FIELD_UNIT_GUID = 4
const UNIT_HEALTH_FIELD_UNIT_NAME = 5
const UNIT_HEALTH_FIELD_HP = 8
const UNIT_HEALTH_FIELD_MAX_HP = 9

// WoW combat log unit flag bit — set when the unit is on the hostile/enemy team.
const UNIT_FLAG_REACTION_HOSTILE = 0x40

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

export interface ArenaZoneEnteredEvent {
  zoneId: number
  zoneName: string
  timestamp: Date
}

export interface ArenaZoneLeftEvent {
  timestamp: Date
}

export interface ArenaMatchStartEvent {
  instanceId: number
  zoneName: string
  bracket: ArenaBracket
  // Which WoW team slot the logging player is on (0 or 1).
  // Use this to determine which COMBATANT_INFO team value maps to "our team".
  localTeam: number
  timestamp: Date
}

export interface SpellAuraEvent {
  casterGuid: string
  casterName: string
  targetGuid: string
  targetName: string
  targetFlags: number
  spellId: number
  spellName: string
  timestamp: Date
}

export interface ArenaMatchEndEvent {
  // Raw team index (0 or 1) that won, straight from the log. WIN/LOSS is NOT derived
  // here — ARENA_MATCH_START's "localTeam" field does not reliably identify which team
  // the logging player is on (verified against real logs: it stays constant across an
  // entire session regardless of actual per-match team assignment). Callers must resolve
  // the player's real team from COMBATANT_INFO (which does vary correctly per match) —
  // see RecorderStateMachine.resolveLocalTeam.
  winningTeam: number
  durationSecs: number
  timestamp: Date
}

export interface SoloShuffleRoundEndEvent {
  roundNumber: number
  result: ArenaResult
  durationSecs: number
  sessionId: string
  timestamp: Date
}

export interface SoloShuffleSessionEndEvent {
  sessionId: string
  totalRounds: number
  ratingBefore: number
  ratingAfter: number
  playerGuid: string
  playerName: string
  timestamp: Date
}

export interface SpellCastEvent {
  casterGuid: string
  casterName: string
  targetGuid: string
  targetName: string
  // Raw WoW unit flags for the spell target. Use UNIT_FLAG_REACTION_HOSTILE (0x40) to
  // determine whether the target is an enemy (hostile) or a teammate (friendly).
  targetFlags: number
  spellId: number
  spellName: string
  eventCategory: 'cc' | 'defensive' | 'offensive' | 'interrupt' | 'cc-break' | 'trinket'
  timestamp: Date
}

export interface ArenaMatchStatsEntryEvent {
  playerGuid: string
  playerName: string
  team: number  // 0 = local player's team, 1 = enemy team (STATS_FIELD_TEAM — verify per patch)
  ratingBefore: number
  ratingAfter: number
  timestamp: Date
}

export interface HealerCastEvent {
  casterGuid: string
  casterName: string
  timestamp: Date
}

// Fired for SPELL_DAMAGE, SWING_DAMAGE, SPELL_PERIODIC_DAMAGE — used for death summary and team charts
export interface SpellDamageEvent {
  casterGuid: string
  casterName: string
  casterFlags: number
  targetGuid: string
  targetName: string
  // Raw unit flags for the target — lets Mythic+ pick out party members
  targetFlags?: number
  spellId?: number    // undefined for SWING_DAMAGE
  spellName: string   // 'Auto Attack' for SWING_DAMAGE
  amount: number
  isCritical: boolean
  timestamp: Date
}

// Fired for SPELL_HEAL / SPELL_PERIODIC_HEAL — used for team healing charts and
// per-target "healing received" tracking (death recap).
export interface SpellHealAmountEvent {
  casterGuid: string
  casterName: string
  targetGuid?: string
  targetName?: string
  spellId?: number
  spellName?: string
  amount: number
  timestamp: Date
}

// Fired for SPELL_ABSORBED — damage prevented by a shield. casterGuid/casterName here is
// the player who CAST the shield (not the attacker or the shielded victim) — used to
// attribute "shielding done" to the shield's owner, same shape as spellHealAmount.
export interface SpellAbsorbEvent {
  casterGuid: string
  casterName: string
  amount: number
  timestamp: Date
}

// Fired for SPELL_INTERRUPT — a successful interrupt landed on a casting target.
export interface SpellInterruptSuccessEvent {
  casterGuid: string
  casterName: string
  casterFlags: number
  targetGuid: string
  targetName: string
  targetFlags: number
  spellId: number
  spellName: string
  interruptedSpellId: number
  interruptedSpellName: string
  timestamp: Date
}

// Fired when Precognition (377362) is applied to a player — indicates someone wasted
// an interrupt on them while they weren't casting an interruptible spell.
export interface PrecognitionGainedEvent {
  playerGuid: string
  playerName: string
  timestamp: Date
}

export interface CombatantInfoEvent {
  playerGuid: string
  playerName: string
  team: number        // 0 = enemy, 1 = local player's team
  personalRating: number
  specId: number | null  // WoW spec ID (last stat field before the talents bracket), null if not available
  timestamp: Date
}

export interface UnitDiedEvent {
  unitGuid: string
  unitName: string
  // Raw WoW unit flags for the unit that died. Use UNIT_FLAG_REACTION_HOSTILE (0x40)
  // to determine whether the death was a player-team death or an enemy death.
  destFlags: number
  // true = feign death / battle-res / ankh; unit did not actually die. Ignore for round result tracking.
  unconscious?: boolean
  timestamp: Date
}

// Fired for UNIT_HEALTH events (requires Advanced Combat Logging in WoW).
// Provides current HP snapshot per unit — used to attach HP% to death summary hits.
export interface UnitHealthEvent {
  unitGuid: string
  unitName: string
  hp: number
  maxHp: number
  timestamp: Date
}

// Fired for every ZONE_CHANGE, arena or not. Mythic+ uses it to notice the player
// leaving the dungeon mid-key (arena keeps using arenaZoneEntered/arenaZoneLeft).
export interface ZoneChangedEvent {
  instanceId: number
  zoneName: string
  timestamp: Date
}

export interface ChallengeModeStartEvent {
  zoneName: string
  instanceId: number
  challengeModeId: number
  keystoneLevel: number
  affixIds: number[]
  timestamp: Date
}

export interface ChallengeModeEndEvent {
  instanceId: number
  success: boolean
  keystoneLevel: number
  // 0 when the key was abandoned/reset rather than completed
  totalTimeMs: number
  oldRating?: number
  newRating?: number
  timestamp: Date
}

export interface EncounterStartEvent {
  encounterId: number
  encounterName: string
  difficultyId: number
  groupSize: number
  instanceId: number
  timestamp: Date
}

export interface EncounterEndEvent {
  encounterId: number
  encounterName: string
  difficultyId: number
  groupSize: number
  success: boolean
  fightTimeMs?: number
  timestamp: Date
}

// Heartbeat: fired at most once per second of log time while lines are arriving. Lets
// Mythic+ notice a log that has simply stopped (game closed, logging turned off) without
// subscribing to every event type.
export interface LogActivityEvent {
  timestamp: Date
}

// Re-exported so callers can test hostility without coupling to the bit value.
export { UNIT_FLAG_REACTION_HOSTILE }

// ---------------------------------------------------------------------------
// Typed event map for the EventEmitter
// ---------------------------------------------------------------------------

export interface ParserEventMap {
  arenaZoneEntered: ArenaZoneEnteredEvent
  arenaZoneLeft: ArenaZoneLeftEvent
  arenaMatchStart: ArenaMatchStartEvent
  arenaMatchEnd: ArenaMatchEndEvent
  soloShuffleRoundEnd: SoloShuffleRoundEndEvent
  soloShuffleSessionEnd: SoloShuffleSessionEndEvent
  spellCast: SpellCastEvent
  spellAuraApplied: SpellAuraEvent
  spellAuraRemoved: SpellAuraEvent
  unitDied: UnitDiedEvent
  unitHealth: UnitHealthEvent
  arenaMatchStatsEntry: ArenaMatchStatsEntryEvent
  healerCast: HealerCastEvent
  combatantInfo: CombatantInfoEvent
  spellDamage: SpellDamageEvent
  spellHealAmount: SpellHealAmountEvent
  spellAbsorb: SpellAbsorbEvent
  spellInterruptSuccess: SpellInterruptSuccessEvent
  precognitionGained: PrecognitionGainedEvent
  zoneChanged: ZoneChangedEvent
  challengeModeStart: ChallengeModeStartEvent
  challengeModeEnd: ChallengeModeEndEvent
  encounterStart: EncounterStartEvent
  encounterEnd: EncounterEndEvent
  logActivity: LogActivityEvent
}

// ---------------------------------------------------------------------------
// Internal parser state for the current arena session
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string
  zoneId: number
  zoneName: string
  bracket: ArenaBracket | null
  isSoloShuffle: boolean
  localTeam: number   // 0 or 1 — which team the logging player is on (from ARENA_MATCH_START)
  // Solo Shuffle only
  roundCount: number
  roundResults: ArenaResult[]
}

// ---------------------------------------------------------------------------
// CombatLogParser
// ---------------------------------------------------------------------------

export class CombatLogParser extends EventEmitter {
  private session: SessionState | null = null
  // GUID → player name, built from standard-prefix spell/aura events
  private readonly guidNames = new Map<string, string>()
  // Pet/totem/summon GUID → owning player GUID, built from SPELL_SUMMON events (the
  // log event fired when a player creates a totem/pet/guardian) — see
  // resolveEffectiveCaster for why this is needed instead of the advanced-logging block.
  private readonly summonOwners = new Map<string, string>()
  // Log time of the last logActivity emit (ms), for throttling
  private lastActivityMs = 0

  // Typed overrides for EventEmitter methods
  override emit<K extends keyof ParserEventMap>(event: K, payload: ParserEventMap[K]): boolean {
    return super.emit(event, payload)
  }

  override on<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    return super.on(event, listener)
  }

  override once<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    return super.once(event, listener)
  }

  override off<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    return super.off(event, listener)
  }

  // Exposes the accumulated GUID→name cache so callers can backfill names that were
  // missing at event-emit time (e.g. COMBATANT_INFO fires before combat spell events).
  get nameCache(): ReadonlyMap<string, string> {
    return this.guidNames
  }

  // Reset all session state — call on app start or after crash recovery
  reset(): void {
    this.session = null
    this.guidNames.clear()
    this.summonOwners.clear()
  }

  // Main entry point. Call once per log line.
  processLine(line: string): void {
    const parsed = parseLine(line)
    if (parsed === null) return

    const { timestamp, eventType, fields } = parsed

    if (timestamp.getTime() - this.lastActivityMs >= 1000) {
      this.lastActivityMs = timestamp.getTime()
      this.emit('logActivity', { timestamp })
    }

    // Cache GUID→name from standard unit-prefix events (srcGUID/srcName, dstGUID/dstName).
    // Player names always follow "CharacterName-RealmName" format — guard with includes('-')
    // to avoid overwriting the cache with numeric fields (e.g. COMBATANT_INFO team index).
    if (fields[0]?.startsWith('Player-') && fields[1]?.includes('-')) {
      this.guidNames.set(fields[0], fields[1])
    }
    if (fields[4]?.startsWith('Player-') && fields[5]?.includes('-')) {
      this.guidNames.set(fields[4], fields[5])
    }

    switch (eventType) {
      case 'SPELL_SUMMON':
        this.handleSpellSummon(fields)
        break
      case 'COMBATANT_INFO':
        this.handleCombatantInfo(fields, line, timestamp)
        break
      case 'ZONE_CHANGE':
        this.handleZoneChange(fields, timestamp)
        break
      case 'ARENA_MATCH_START':
        this.handleArenaMatchStart(fields, timestamp)
        break
      case 'CHALLENGE_MODE_START':
        this.handleChallengeModeStart(fields, timestamp)
        break
      case 'CHALLENGE_MODE_END':
        this.handleChallengeModeEnd(fields, timestamp)
        break
      case 'ENCOUNTER_START':
        this.handleEncounterStart(fields, timestamp)
        break
      case 'ENCOUNTER_END':
        this.handleEncounterEnd(fields, timestamp)
        break
      case 'ARENA_MATCH_END':
        this.handleArenaMatchEnd(fields, timestamp)
        break
      case 'ARENA_MATCH_STATS':
        this.handleArenaMatchStats(fields, timestamp)
        break
      case 'SPELL_CAST_SUCCESS':
        this.handleSpellCastSuccess(fields, timestamp)
        break
      case 'SPELL_INTERRUPT':
        this.handleSpellInterrupt(fields, timestamp)
        break
      case 'SPELL_AURA_APPLIED':
        this.handleSpellAura(fields, timestamp, 'spellAuraApplied')
        break
      case 'SPELL_AURA_REMOVED':
        this.handleSpellAura(fields, timestamp, 'spellAuraRemoved')
        break
      case 'SPELL_HEAL':
      case 'SPELL_PERIODIC_HEAL':
        this.handleSpellHeal(fields, timestamp)
        break
      case 'SPELL_DAMAGE':
      case 'SPELL_PERIODIC_DAMAGE':
        this.handleSpellDamage(fields, timestamp)
        break
      case 'SWING_DAMAGE':
        this.handleSwingDamage(fields, timestamp)
        break
      case 'SPELL_ABSORBED':
        this.handleSpellAbsorbed(fields, timestamp)
        break
      case 'UNIT_DIED':
        this.handleUnitDied(fields, timestamp)
        break
      case 'UNIT_HEALTH':
        this.handleUnitHealth(fields, timestamp)
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private handleZoneChange(fields: string[], timestamp: Date): void {
    const rawId = fields[ZONE_FIELD_INSTANCE_ID]
    const zoneName = fields[ZONE_FIELD_ZONE_NAME] ?? ''
    const instanceId = parseInt(rawId ?? '', 10)

    if (isNaN(instanceId)) return

    this.emit('zoneChanged', { instanceId, zoneName, timestamp })

    const isArena = ARENA_ZONE_IDS.has(instanceId)

    if (isArena) {
      const resolvedName = ARENA_ZONE_NAMES[instanceId] ?? zoneName

      this.session = {
        sessionId: timestamp.toISOString(),
        zoneId: instanceId,
        zoneName: resolvedName,
        bracket: null,
        isSoloShuffle: false,
        localTeam: 0,
        roundCount: 0,
        roundResults: []
      }

      this.emit('arenaZoneEntered', {
        zoneId: instanceId,
        zoneName: resolvedName,
        timestamp
      })
    } else if (this.session !== null) {
      // Left an arena zone
      this.session = null
      this.emit('arenaZoneLeft', { timestamp })
    }
  }

  private handleChallengeModeStart(fields: string[], timestamp: Date): void {
    const instanceId = parseInt(fields[CM_START_FIELD_INSTANCE_ID] ?? '', 10)
    const keystoneLevel = parseInt(fields[CM_START_FIELD_KEYSTONE_LEVEL] ?? '', 10)
    if (isNaN(instanceId) || isNaN(keystoneLevel)) return

    const challengeModeId = parseInt(fields[CM_START_FIELD_CHALLENGE_MODE_ID] ?? '', 10)
    // parseCsvFields doesn't understand brackets, so "[9,10,147]" arrives split across
    // several fields — rejoin everything from the affix field onwards.
    const affixIds = fields
      .slice(CM_START_FIELD_AFFIXES)
      .join(',')
      .replace(/[[\]]/g, '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n))

    this.emit('challengeModeStart', {
      zoneName: fields[CM_START_FIELD_ZONE_NAME] ?? '',
      instanceId,
      challengeModeId: isNaN(challengeModeId) ? 0 : challengeModeId,
      keystoneLevel,
      affixIds,
      timestamp
    })
  }

  private handleChallengeModeEnd(fields: string[], timestamp: Date): void {
    const instanceId = parseInt(fields[CM_END_FIELD_INSTANCE_ID] ?? '', 10)
    if (isNaN(instanceId)) return

    const keystoneLevel = parseInt(fields[CM_END_FIELD_KEYSTONE_LEVEL] ?? '', 10)
    const totalTimeMs = parseInt(fields[CM_END_FIELD_TOTAL_TIME_MS] ?? '', 10)
    const oldRating = parseFloat(fields[CM_END_FIELD_OLD_RATING] ?? '')
    const newRating = parseFloat(fields[CM_END_FIELD_NEW_RATING] ?? '')

    this.emit('challengeModeEnd', {
      instanceId,
      success: fields[CM_END_FIELD_SUCCESS] === '1',
      keystoneLevel: isNaN(keystoneLevel) ? 0 : keystoneLevel,
      totalTimeMs: isNaN(totalTimeMs) ? 0 : totalTimeMs,
      oldRating: isNaN(oldRating) ? undefined : oldRating,
      newRating: isNaN(newRating) ? undefined : newRating,
      timestamp
    })
  }

  private handleEncounterStart(fields: string[], timestamp: Date): void {
    const encounterId = parseInt(fields[ENCOUNTER_FIELD_ID] ?? '', 10)
    if (isNaN(encounterId)) return

    this.emit('encounterStart', {
      encounterId,
      encounterName: fields[ENCOUNTER_FIELD_NAME] ?? '',
      difficultyId: parseInt(fields[ENCOUNTER_FIELD_DIFFICULTY_ID] ?? '', 10) || 0,
      groupSize: parseInt(fields[ENCOUNTER_FIELD_GROUP_SIZE] ?? '', 10) || 0,
      instanceId: parseInt(fields[ENCOUNTER_START_FIELD_INSTANCE_ID] ?? '', 10) || 0,
      timestamp
    })
  }

  private handleEncounterEnd(fields: string[], timestamp: Date): void {
    const encounterId = parseInt(fields[ENCOUNTER_FIELD_ID] ?? '', 10)
    if (isNaN(encounterId)) return

    const fightTimeMs = parseInt(fields[ENCOUNTER_END_FIELD_FIGHT_TIME_MS] ?? '', 10)

    this.emit('encounterEnd', {
      encounterId,
      encounterName: fields[ENCOUNTER_FIELD_NAME] ?? '',
      difficultyId: parseInt(fields[ENCOUNTER_FIELD_DIFFICULTY_ID] ?? '', 10) || 0,
      groupSize: parseInt(fields[ENCOUNTER_FIELD_GROUP_SIZE] ?? '', 10) || 0,
      success: fields[ENCOUNTER_END_FIELD_SUCCESS] === '1',
      fightTimeMs: isNaN(fightTimeMs) ? undefined : fightTimeMs,
      timestamp
    })
  }

  private handleArenaMatchStart(fields: string[], timestamp: Date): void {
    if (this.session === null) return

    const rawInstanceId = fields[MATCH_START_FIELD_INSTANCE_ID]
    const rawBracket = fields[MATCH_START_FIELD_BRACKET]

    if (rawBracket === undefined) return

    const bracketLower = rawBracket.toLowerCase()
    const bracket = BRACKET_FIELD_MAP[bracketLower]
    if (bracket === undefined) return

    const instanceId = parseInt(rawInstanceId ?? '', 10)
    if (isNaN(instanceId)) return

    this.session.bracket = bracket
    this.session.isSoloShuffle = bracket === 'solo-shuffle'
    this.session.localTeam = parseInt(fields[MATCH_START_FIELD_LOCAL_TEAM] ?? '0', 10) || 0

    // Diagnostic: log raw fields to verify indices per Midnight patch
    console.warn('[Parser] ARENA_MATCH_START fields:', JSON.stringify(fields.slice(0, 6)))
    console.warn(`[Parser] MATCH_START → bracket="${bracket}", localTeam=${this.session.localTeam}`)

    this.emit('arenaMatchStart', {
      instanceId,
      zoneName: this.session.zoneName,
      bracket,
      localTeam: this.session.localTeam,
      timestamp
    })
  }

  private handleArenaMatchEnd(fields: string[], timestamp: Date): void {
    if (this.session === null || this.session.bracket === null) return

    const rawWinningTeam = fields[MATCH_END_FIELD_WINNING_TEAM]
    const rawDuration = fields[MATCH_END_FIELD_DURATION]

    if (rawWinningTeam === undefined || rawDuration === undefined) return

    const winningTeam = parseInt(rawWinningTeam, 10)
    const durationSecs = parseInt(rawDuration, 10)

    if (isNaN(winningTeam) || isNaN(durationSecs)) return

    // Diagnostic: log raw fields to verify indices per Midnight patch
    console.warn('[Parser] ARENA_MATCH_END fields:', JSON.stringify(fields.slice(0, 4)))
    console.warn(`[Parser] MATCH_END → winningTeam=${winningTeam}, durationSecs=${durationSecs}`)

    // Midnight (12.x): ARENA_MATCH_END fires once at the end of the entire session for
    // all brackets including Solo Shuffle — emit arenaMatchEnd unconditionally.
    this.emit('arenaMatchEnd', {
      winningTeam,
      durationSecs,
      timestamp
    })
  }

  private handleArenaMatchStats(fields: string[], timestamp: Date): void {
    const playerGuid = fields[STATS_FIELD_PLAYER_GUID]
    const playerName = fields[STATS_FIELD_PLAYER_NAME]
    const rawTeam = fields[STATS_FIELD_TEAM]
    const rawRatingBefore = fields[STATS_FIELD_RATING_BEFORE]
    const rawRatingAfter = fields[STATS_FIELD_RATING_AFTER]

    if (playerGuid === undefined || playerName === undefined) return

    const team = parseInt(rawTeam ?? '0', 10)
    const ratingBefore = parseInt(rawRatingBefore ?? '0', 10)
    const ratingAfter = parseInt(rawRatingAfter ?? '0', 10)

    // Emit per-player stats entry for all bracket types so the log analyser can
    // build team compositions and per-player rating changes.
    this.emit('arenaMatchStatsEntry', {
      playerGuid,
      playerName,
      team: isNaN(team) ? 0 : team,
      ratingBefore: isNaN(ratingBefore) ? 0 : ratingBefore,
      ratingAfter: isNaN(ratingAfter) ? 0 : ratingAfter,
      timestamp
    })

    // Solo Shuffle session-end logic — fires once after all 6 rounds are done.
    if (
      this.session !== null &&
      this.session.isSoloShuffle &&
      this.session.roundCount >= SOLO_SHUFFLE_ROUNDS_PER_SESSION &&
      !isNaN(ratingBefore) &&
      !isNaN(ratingAfter)
    ) {
      const { sessionId, roundCount } = this.session
      this.session = null

      this.emit('soloShuffleSessionEnd', {
        sessionId,
        totalRounds: roundCount,
        ratingBefore,
        ratingAfter,
        playerGuid,
        playerName,
        timestamp
      })
    }
  }

  private handleSpellCastSuccess(fields: string[], timestamp: Date): void {
    const rawSpellId = fields[SPELL_FIELD_SPELL_ID]
    if (rawSpellId === undefined) return

    const spellId = parseInt(rawSpellId, 10)
    if (isNaN(spellId)) return

    const category = resolveSpellCategory(spellId)
    if (category === null) return

    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = fields[SPELL_FIELD_CASTER_NAME] ?? ''
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = fields[SPELL_FIELD_TARGET_NAME] ?? ''
    const spellName = fields[SPELL_FIELD_SPELL_NAME] ?? ''

    if (casterGuid === undefined || targetGuid === undefined) return

    const targetFlags = parseHexFlags(fields[SPELL_FIELD_TARGET_FLAGS] ?? '0')

    this.emit('spellCast', {
      casterGuid,
      casterName,
      targetGuid,
      targetName,
      targetFlags,
      spellId,
      spellName,
      eventCategory: category,
      timestamp
    })
  }

  private handleSpellAura(
    fields: string[],
    timestamp: Date,
    event: 'spellAuraApplied' | 'spellAuraRemoved'
  ): void {
    const rawSpellId = fields[SPELL_FIELD_SPELL_ID]
    if (rawSpellId === undefined) return
    const spellId = parseInt(rawSpellId, 10)
    if (isNaN(spellId)) return

    // Precognition: fired when an interrupt is wasted on a player who wasn't casting.
    // Self-applied buff — src and dst are the same player.
    if (event === 'spellAuraApplied' && spellId === PRECOGNITION_SPELL_ID) {
      const playerGuid = fields[SPELL_FIELD_TARGET_GUID]
      const playerName = fields[SPELL_FIELD_TARGET_NAME] ?? ''
      if (playerGuid !== undefined) {
        this.emit('precognitionGained', { playerGuid, playerName, timestamp })
      }
      return
    }

    // Previously CC-only; widened so the mistake detector can also track aura windows
    // for defensives/immunities (RecorderStateMachine.onAuraApplied/onAuraRemoved keeps
    // the original CC-only activeCCs/DR bookkeeping strictly gated on SPELL_IDS_CC —
    // this widening only adds a separate, non-CC aura-window tracker there).
    if (!SPELL_IDS_CC.has(spellId) && !SPELL_IDS_DEFENSIVE.has(spellId) && !SPELL_IDS_IMMUNITY.has(spellId)) return

    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = fields[SPELL_FIELD_CASTER_NAME] ?? ''
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = fields[SPELL_FIELD_TARGET_NAME] ?? ''
    const spellName = fields[SPELL_FIELD_SPELL_NAME] ?? ''

    if (casterGuid === undefined || targetGuid === undefined) return

    const targetFlags = parseHexFlags(fields[SPELL_FIELD_TARGET_FLAGS] ?? '0')

    this.emit(event, { casterGuid, casterName, targetGuid, targetName, targetFlags, spellId, spellName, timestamp })
  }

  private handleSpellInterrupt(fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = fields[SPELL_FIELD_CASTER_NAME] ?? ''
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = fields[SPELL_FIELD_TARGET_NAME] ?? ''

    if (casterGuid === undefined || targetGuid === undefined) return

    const rawSpellId = fields[INTERRUPT_FIELD_SPELL_ID]
    const rawInterruptedSpellId = fields[INTERRUPT_FIELD_INTERRUPTED_SPELL_ID]
    if (rawSpellId === undefined || rawInterruptedSpellId === undefined) return

    const spellId = parseInt(rawSpellId, 10)
    const interruptedSpellId = parseInt(rawInterruptedSpellId, 10)
    if (isNaN(spellId) || isNaN(interruptedSpellId)) return

    const spellName = fields[INTERRUPT_FIELD_SPELL_NAME] ?? ''
    const interruptedSpellName = fields[INTERRUPT_FIELD_INTERRUPTED_SPELL_NAME] ?? ''
    const casterFlags = parseHexFlags(fields[SPELL_FIELD_CASTER_FLAGS] ?? '0')
    const targetFlags = parseHexFlags(fields[SPELL_FIELD_TARGET_FLAGS] ?? '0')

    this.emit('spellInterruptSuccess', {
      casterGuid,
      casterName,
      casterFlags,
      targetGuid,
      targetName,
      targetFlags,
      spellId,
      spellName,
      interruptedSpellId,
      interruptedSpellName,
      timestamp
    })
  }

  private handleCombatantInfo(fields: string[], rawLine: string, timestamp: Date): void {
    const playerGuid = fields[COMBATANT_FIELD_GUID]
    const rawTeam = fields[COMBATANT_FIELD_TEAM]
    if (playerGuid === undefined || rawTeam === undefined) return

    const team = parseInt(rawTeam, 10)
    if (isNaN(team)) return

    // Name is not present in COMBATANT_INFO itself — resolve from the GUID→name cache
    // populated by standard-prefix events (SPELL_AURA_REMOVED etc.) that fire nearby.
    const playerName = this.guidNames.get(playerGuid) ?? ''

    // specID is the LAST plain numeric field before the FIRST '[' bracket (the stat
    // block: strength/agility/.../versatility/armor/specID, then talents/pvp-talents/
    // gear/aura brackets follow) — verified against real Midnight combat logs, where
    // this field consistently matches a valid spec ID (e.g. 64=Frost Mage, 260=Outlaw
    // Rogue, 1467=Devastation Evoker). Previously this read the first field in the
    // trailing section AFTER the LAST bracket instead, which is a different field
    // entirely and produced garbage (e.g. "78", not a real spec ID) — silently
    // dropping every player's spec whenever that garbage number didn't happen to
    // collide with a real WOW_SPEC_ID_MAP key.
    const specId = parseCombatantInfoSpecId(rawLine)

    // Trailing fields after the last ']' bracket section: [.., personalRating, ..]
    const trailing = parseCombatantInfoTrailing(rawLine)
    if (trailing.length < 4) return

    // personalRating is the third-to-last field (index -2)
    const personalRating = parseInt(trailing[trailing.length - 2] ?? '', 10)
    if (isNaN(personalRating)) return

    this.emit('combatantInfo', { playerGuid, playerName, team, personalRating, specId, timestamp })
  }

  // Pets/totems/summons (Healing Stream Totem, Water Elemental, Xuen, Storm Earth and
  // Fire clones, etc.) report their OWN guid+name as the spell's caster in the combat
  // log, not their owner's. Advanced Combat Logging's ownerGUID field (part of the
  // per-event advanced metadata block) lets us redirect these back to the owning
  // player, so a Shaman's totem heals count toward the Shaman instead of showing up as
  // a separate "Healing Stream Totem" entry in meters/death recaps.
  private resolveEffectiveCaster(casterGuid: string, casterName: string): { guid: string; name: string } {
    if (casterGuid.startsWith('Player-')) return { guid: casterGuid, name: casterName }
    const ownerGuid = this.summonOwners.get(casterGuid)
    if (ownerGuid !== undefined) {
      const ownerName = this.guidNames.get(ownerGuid)
      if (ownerName !== undefined) return { guid: ownerGuid, name: ownerName }
    }
    return { guid: casterGuid, name: casterName }
  }

  // SPELL_SUMMON fires when a player creates a pet/totem/guardian — caster is the
  // owning player, target is the newly created summon's GUID. Standard 11-field prefix,
  // no advanced-logging suffix (verified against real logs).
  private handleSpellSummon(fields: string[]): void {
    const ownerGuid = fields[SPELL_FIELD_CASTER_GUID]
    const summonGuid = fields[SPELL_FIELD_TARGET_GUID]
    if (ownerGuid === undefined || summonGuid === undefined) return
    if (!ownerGuid.startsWith('Player-')) return
    this.summonOwners.set(summonGuid, ownerGuid)
  }

  private handleSpellHeal(fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = sanitizeName(fields[SPELL_FIELD_CASTER_NAME])
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = sanitizeName(fields[SPELL_FIELD_TARGET_NAME])
    const spellId = parseInt(fields[SPELL_FIELD_SPELL_ID] ?? '', 10)
    const spellName = fields[SPELL_FIELD_SPELL_NAME]
    if (casterGuid === undefined || fields[SPELL_FIELD_CASTER_NAME] === undefined) return

    // Emit heal amount event for ALL heals (including self) — used for team heal charts
    // and per-target healing-received tracking (death recap). Redirect pet/totem heals
    // (Healing Stream Totem, Earthliving, etc.) to their owning player.
    const amount = parseHealAmount(fields)
    if (!isNaN(amount) && amount > 0) {
      const effective = this.resolveEffectiveCaster(casterGuid, casterName)
      this.emit('spellHealAmount', {
        casterGuid: effective.guid,
        casterName: effective.name,
        targetGuid,
        targetName,
        spellId: isNaN(spellId) ? undefined : spellId,
        spellName,
        amount,
        timestamp
      })
    }

    // Only count heals cast DIRECTLY by a player on another player for healer
    // detection — self-heals (leech, Healthstone) and incidental totem/pet ticks
    // (which don't reflect the owner's own healer role) must not trigger it.
    if (!casterGuid.startsWith('Player-') || targetGuid === casterGuid) return
    this.emit('healerCast', { casterGuid, casterName, timestamp })
  }

  private handleSpellAbsorbed(fields: string[], timestamp: Date): void {
    const casterGuid = fields[ABSORBED_FIELD_CASTER_GUID]
    const casterName = sanitizeName(fields[ABSORBED_FIELD_CASTER_NAME])
    if (casterGuid === undefined || !casterName) return

    const amount = parseInt(fields[ABSORBED_FIELD_AMOUNT] ?? '0', 10)
    if (isNaN(amount) || amount <= 0) return

    this.emit('spellAbsorb', { casterGuid, casterName, amount, timestamp })
  }

  private handleSpellDamage(fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = sanitizeName(fields[SPELL_FIELD_CASTER_NAME])
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = sanitizeName(fields[SPELL_FIELD_TARGET_NAME])
    if (casterGuid === undefined || targetGuid === undefined) return

    // Only track damage between players (Pet/NPC hits are excluded by GUID prefix)
    if (!targetGuid.startsWith('Player-')) return

    const rawSpellId = fields[SPELL_FIELD_SPELL_ID]
    const spellId = rawSpellId !== undefined ? parseInt(rawSpellId, 10) : NaN
    const spellName = fields[SPELL_FIELD_SPELL_NAME] ?? 'Unknown'
    const amount = parseSpellDamageAmount(fields)
    if (isNaN(amount) || amount <= 0) return

    const casterFlags = parseHexFlags(fields[SPELL_FIELD_CASTER_FLAGS] ?? '0')
    const targetFlags = parseHexFlags(fields[SPELL_FIELD_TARGET_FLAGS] ?? '0')
    // Redirect pet/summon damage (Xuen, Storm Earth and Fire clones, Water Elemental,
    // etc.) to the owning player — see resolveEffectiveCaster.
    const effective = this.resolveEffectiveCaster(casterGuid, casterName)

    this.emit('spellDamage', {
      casterGuid: effective.guid,
      casterName: effective.name,
      casterFlags,
      targetGuid,
      targetName,
      targetFlags,
      spellId: !isNaN(spellId) ? spellId : undefined,
      spellName,
      amount,
      isCritical: parseSpellDamageIsCritical(fields),
      timestamp
    })
  }

  private handleSwingDamage(fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = sanitizeName(fields[SPELL_FIELD_CASTER_NAME])
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = sanitizeName(fields[SPELL_FIELD_TARGET_NAME])
    if (casterGuid === undefined || targetGuid === undefined) return

    if (!targetGuid.startsWith('Player-')) return

    const amount = parseSwingDamageAmount(fields)
    if (isNaN(amount) || amount <= 0) return

    const casterFlags = parseHexFlags(fields[SPELL_FIELD_CASTER_FLAGS] ?? '0')
    const targetFlags = parseHexFlags(fields[SPELL_FIELD_TARGET_FLAGS] ?? '0')
    const effective = this.resolveEffectiveCaster(casterGuid, casterName)

    this.emit('spellDamage', {
      casterGuid: effective.guid,
      casterName: effective.name,
      casterFlags,
      targetGuid,
      targetName,
      targetFlags,
      spellId: undefined,
      spellName: 'Auto Attack',
      amount,
      isCritical: parseSwingDamageIsCritical(fields),
      timestamp
    })
  }

  private handleUnitDied(fields: string[], timestamp: Date): void {
    const unitGuid = fields[UNIT_DIED_FIELD_DEST_GUID]
    const unitName = fields[UNIT_DIED_FIELD_DEST_NAME]

    if (unitGuid === undefined || unitName === undefined) return

    const destFlags = parseHexFlags(fields[UNIT_DIED_FIELD_DEST_FLAGS] ?? '0')
    const unconscious = fields[8] === '1'

    this.emit('unitDied', {
      unitGuid,
      unitName,
      destFlags,
      unconscious,
      timestamp
    })
  }

  private handleUnitHealth(fields: string[], timestamp: Date): void {
    const unitGuid = fields[UNIT_HEALTH_FIELD_UNIT_GUID]
    const unitName = fields[UNIT_HEALTH_FIELD_UNIT_NAME]
    if (unitGuid === undefined || unitName === undefined) return
    // Only track player units
    if (!unitGuid.startsWith('Player-')) return

    const hp = parseInt(fields[UNIT_HEALTH_FIELD_HP] ?? '', 10)
    const maxHp = parseInt(fields[UNIT_HEALTH_FIELD_MAX_HP] ?? '', 10)
    if (isNaN(hp) || isNaN(maxHp) || maxHp <= 0) return

    this.emit('unitHealth', { unitGuid, unitName, hp, maxHp, timestamp })
  }
}

// ---------------------------------------------------------------------------
// Utility functions (module-private)
// ---------------------------------------------------------------------------

function resolveSpellCategory(spellId: number): SpellCastEvent['eventCategory'] | null {
  if (SPELL_IDS_TRINKET.has(spellId)) return 'trinket'
  if (SPELL_IDS_CC.has(spellId)) return 'cc'
  if (SPELL_IDS_DEFENSIVE.has(spellId)) return 'defensive'
  if (SPELL_IDS_OFFENSIVE.has(spellId)) return 'offensive'
  if (SPELL_IDS_INTERRUPT.has(spellId)) return 'interrupt'
  if (SPELL_IDS_CC_BREAK.has(spellId)) return 'cc-break'
  return null
}

interface ParsedLine {
  timestamp: Date
  eventType: string
  fields: string[]
}

function parseLine(line: string): ParsedLine | null {
  // Split on the first occurrence of two consecutive spaces
  const separatorIdx = line.indexOf('  ')
  if (separatorIdx === -1) return null

  const rawTimestamp = line.substring(0, separatorIdx)
  const rest = line.substring(separatorIdx + 2)

  const timestamp = parseWowTimestamp(rawTimestamp)
  if (timestamp === null) return null

  const fields = parseCsvFields(rest)
  if (fields.length === 0) return null

  return {
    timestamp,
    eventType: fields[0] ?? '',
    fields: fields.slice(1)
  }
}

// Parses a WoW hex flag string such as "0x548" or "0x514" into a number.
// Returns 0 for any unparseable input.
function parseHexFlags(raw: string): number {
  const n = parseInt(raw, 16)
  return isNaN(n) ? 0 : n
}

// WoW combat log timestamp format: "M/D/YYYY HH:MM:SS.fff" plus, since COMBAT_LOG_VERSION 22
// (12.x), a UTC offset in hours: "10/27/2026 12:59:23.987-4". Older logs and the test
// fixtures have no offset and a 4-digit fraction ("20:00:40.0000"). The fraction is read
// as a decimal fraction of a second, so 3 and 4 digits both come out in milliseconds.
const TIMESTAMP_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,4})(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/

function parseWowTimestamp(raw: string): Date | null {
  const match = TIMESTAMP_RE.exec(raw)
  if (match === null) return null

  const [, month, day, year, hours, minutes, seconds, fraction, sign, offH, offM] = match
  const ms = Math.round(parseFloat(`0.${fraction!}`) * 1000)
  const y = parseInt(year!, 10)
  const mo = parseInt(month!, 10) - 1
  const d = parseInt(day!, 10)
  const h = parseInt(hours!, 10)
  const mi = parseInt(minutes!, 10)
  const sec = parseInt(seconds!, 10)

  // No offset: the log is in the machine's local time.
  if (sign === undefined) return new Date(y, mo, d, h, mi, sec, ms)

  // With an offset the wall-clock fields are local to that offset — convert to UTC.
  const offsetMins = (parseInt(offH!, 10) * 60 + parseInt(offM ?? '0', 10)) * (sign === '-' ? -1 : 1)
  return new Date(Date.UTC(y, mo, d, h, mi, sec, ms) - offsetMins * 60_000)
}

// Extracts trailing numeric fields from a COMBATANT_INFO line by finding the last ']'
// and splitting everything after it on commas.
// Returns e.g. ['76', '41', '1546', '11'] for a 3v3 entry.
function parseCombatantInfoTrailing(line: string): string[] {
  const lastBracket = line.lastIndexOf(']')
  if (lastBracket === -1) return []
  return line
    .substring(lastBracket + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// Extracts the spec ID from a COMBATANT_INFO line — the last plain field in the stat
// block that precedes the first '[' (talents list). See handleCombatantInfo for the
// verification notes on why this position (not the trailing-after-last-bracket one)
// is correct.
function parseCombatantInfoSpecId(line: string): number | null {
  const firstBracket = line.indexOf('[')
  if (firstBracket === -1) return null
  const statFields = line
    .substring(0, firstBracket)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const rawSpecId = parseInt(statFields[statFields.length - 1] ?? '', 10)
  return !isNaN(rawSpecId) && rawSpecId > 0 ? rawSpecId : null
}

// Minimal CSV parser — handles double-quoted fields.
// WoW does not embed escaped quotes inside quoted fields.
function parseCsvFields(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  result.push(current)
  return result
}
