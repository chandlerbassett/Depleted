// Parses WoW combat log lines and emits typed Mythic+ events.
// Line format: "M/D/YYYY HH:MM:SS.mmm-4  EVENT_TYPE,field1,field2,..." (see parseWowTimestamp)
// Two spaces separate the timestamp from the event data.

import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// ZONE_CHANGE field indices
// ---------------------------------------------------------------------------
const ZONE_FIELD_INSTANCE_ID = 0
const ZONE_FIELD_ZONE_NAME = 1

// ---------------------------------------------------------------------------
// Mythic+ / encounter field indices (0-indexed, after the event type field)
//   CHALLENGE_MODE_START,"zoneName",instanceID,challengeModeID,keystoneLevel,[affixIDs]
//   CHALLENGE_MODE_END,instanceID,success,keystoneLevel,totalTimeMs,dungeonScore,overallRating
//     (12.x: a timed +10 logged "...,1,10,1041217,334.258545,3807.285889"; there's no old rating)
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
const CM_END_FIELD_DUNGEON_SCORE = 4
const CM_END_FIELD_OVERALL_RATING = 5

const ENCOUNTER_FIELD_ID = 0
const ENCOUNTER_FIELD_NAME = 1
const ENCOUNTER_FIELD_DIFFICULTY_ID = 2
const ENCOUNTER_FIELD_GROUP_SIZE = 3
const ENCOUNTER_START_FIELD_INSTANCE_ID = 4
const ENCOUNTER_END_FIELD_SUCCESS = 4
const ENCOUNTER_END_FIELD_FIGHT_TIME_MS = 5

// ---------------------------------------------------------------------------
// COMBATANT_INFO field indices (simple prefix fields — before the bracket sections)
// ---------------------------------------------------------------------------
const COMBATANT_FIELD_GUID = 0
const COMBATANT_FIELD_TEAM = 1

// ---------------------------------------------------------------------------
// Spell event field indices
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
// Overkill sits two fields after the amount (amount, baseAmount, overkill, …); -1 when none
function parseSpellOverkill(fields: string[]): number {
  return Math.max(0, parseInt(fields[fields.length - 9] ?? '', 10) || 0)
}
function parseSwingOverkill(fields: string[]): number {
  return Math.max(0, parseInt(fields[fields.length - 8] ?? '', 10) || 0)
}
function parseHealAmount(fields: string[]): number {
  return parseInt(fields[fields.length - 5] ?? '', 10)
}
// Heal suffix: amount, baseAmount, overhealing, absorbed, critical
function parseOverhealing(fields: string[]): number {
  return Math.max(0, parseInt(fields[fields.length - 3] ?? '', 10) || 0)
}

// Advanced-logging block: unitGUID, ownerGUID, … right after the prefix. For SPELL_*
// events it starts after the 3 spell fields; SWING_DAMAGE has no spell fields.
const SPELL_ADVANCED_UNIT_GUID = 11
const SWING_ADVANCED_UNIT_GUID = 8

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
// SPELL_INTERRUPT field indices
// Standard spell prefix, followed by:
//   interruptSpellId, interruptSpellName, school, interruptedSpellId, interruptedSpellName, interruptedSchool
// ---------------------------------------------------------------------------
const INTERRUPT_FIELD_SPELL_ID = 8
const INTERRUPT_FIELD_SPELL_NAME = 9
const INTERRUPT_FIELD_INTERRUPTED_SPELL_ID = 11
const INTERRUPT_FIELD_INTERRUPTED_SPELL_NAME = 12

// SPELL_AURA_APPLIED / SPELL_AURA_REMOVED: standard spell prefix, then auraType
// ("BUFF" | "DEBUFF") — verified against a 12.x log
const AURA_FIELD_TYPE = 11

// ---------------------------------------------------------------------------
// UNIT_DIED field indices
// srcGUID, srcName, srcFlags, srcRaidFlags, destGUID, destName, destFlags, destRaidFlags, unconscious
// ---------------------------------------------------------------------------
const UNIT_DIED_FIELD_DEST_GUID = 4
const UNIT_DIED_FIELD_DEST_NAME = 5
const UNIT_DIED_FIELD_DEST_FLAGS = 6

// WoW combat log unit flag bit — set when the unit is on the hostile/enemy team.
const UNIT_FLAG_REACTION_HOSTILE = 0x40

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

// Fired for SPELL_DAMAGE, SWING_DAMAGE, SPELL_PERIODIC_DAMAGE on a player — used for
// damage taken and the death recap
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

// Fired for damage a player (or their pet/guardian) does to a non-player — mobs and
// bosses. amount excludes overkill.
export interface DamageDoneEvent {
  casterGuid: string
  casterName: string
  casterFlags: number
  amount: number
  timestamp: Date
}

// Fired for SPELL_HEAL / SPELL_PERIODIC_HEAL — used for healing done and per-target
// "healing received" tracking (death recap).
export interface SpellHealAmountEvent {
  casterGuid: string
  casterName: string
  targetGuid?: string
  targetName?: string
  spellId?: number
  spellName?: string
  amount: number
  // Part of amount that landed on a full-health target
  overhealing?: number
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

export interface CombatantInfoEvent {
  playerGuid: string
  playerName: string
  team: number        // 0 = enemy, 1 = local player's team
  personalRating: number
  specId: number | null  // WoW spec ID (last stat field before the talents bracket), null if not available
  // Talent picks from the first bracket: [nodeId, entryId, rank]
  talents: Array<[number, number, number]>
  timestamp: Date
}

// Fired for SPELL_CAST_SUCCESS by a player (not pets) — used by the coach for casts,
// cooldown use and downtime
export interface SpellCastEvent {
  casterGuid: string
  casterName: string
  casterFlags: number
  spellId: number
  spellName: string
  timestamp: Date
}

// Fired for SPELL_AURA_APPLIED / SPELL_AURA_REMOVED buffs on a player — the coach uses
// self-buffs to see how long cooldowns were up
export interface BuffChangeEvent {
  casterGuid: string
  targetGuid: string
  spellId: number
  spellName: string
  applied: boolean
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

// Fired for every ZONE_CHANGE. Mythic+ uses it to notice the player leaving the
// dungeon mid-key.
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
  // Score for this dungeon and overall M+ rating after the key; both 0 on a reset
  dungeonScore?: number
  overallRating?: number
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
  unitDied: UnitDiedEvent
  combatantInfo: CombatantInfoEvent
  spellDamage: SpellDamageEvent
  damageDone: DamageDoneEvent
  spellHealAmount: SpellHealAmountEvent
  spellInterruptSuccess: SpellInterruptSuccessEvent
  spellCast: SpellCastEvent
  // SPELL_CAST_START: a hard cast began (same payload; it may still fail)
  spellCastStart: SpellCastEvent
  buffChange: BuffChangeEvent
  zoneChanged: ZoneChangedEvent
  challengeModeStart: ChallengeModeStartEvent
  challengeModeEnd: ChallengeModeEndEvent
  encounterStart: EncounterStartEvent
  encounterEnd: EncounterEndEvent
  logActivity: LogActivityEvent
}

// ---------------------------------------------------------------------------
// CombatLogParser
// ---------------------------------------------------------------------------

export class CombatLogParser extends EventEmitter {
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
      case 'SPELL_INTERRUPT':
        this.handleSpellInterrupt(fields, timestamp)
        break
      case 'SPELL_CAST_SUCCESS':
        this.handleSpellCast('spellCast', fields, timestamp)
        break
      case 'SPELL_CAST_START':
        this.handleSpellCast('spellCastStart', fields, timestamp)
        break
      case 'SPELL_AURA_APPLIED':
      case 'SPELL_AURA_REMOVED':
        this.handleBuffChange(fields, eventType === 'SPELL_AURA_APPLIED', timestamp)
        break
      case 'SPELL_HEAL':
      case 'SPELL_PERIODIC_HEAL':
        this.handleSpellHeal(fields, timestamp)
        break
      case 'SPELL_DAMAGE':
      case 'SPELL_PERIODIC_DAMAGE':
      case 'RANGE_DAMAGE': // Hunter Auto Shot, same layout as SPELL_DAMAGE
        this.handleSpellDamage(fields, timestamp)
        break
      case 'SWING_DAMAGE':
        this.handleSwingDamage(fields, timestamp)
        break
      case 'UNIT_DIED':
        this.handleUnitDied(fields, timestamp)
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
    const dungeonScore = parseFloat(fields[CM_END_FIELD_DUNGEON_SCORE] ?? '')
    const overallRating = parseFloat(fields[CM_END_FIELD_OVERALL_RATING] ?? '')

    this.emit('challengeModeEnd', {
      instanceId,
      success: fields[CM_END_FIELD_SUCCESS] === '1',
      keystoneLevel: isNaN(keystoneLevel) ? 0 : keystoneLevel,
      totalTimeMs: isNaN(totalTimeMs) ? 0 : totalTimeMs,
      dungeonScore: isNaN(dungeonScore) ? undefined : dungeonScore,
      overallRating: isNaN(overallRating) ? undefined : overallRating,
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

  private handleSpellCast(event: 'spellCast' | 'spellCastStart', fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    if (casterGuid === undefined || !casterGuid.startsWith('Player-')) return
    const spellId = parseInt(fields[SPELL_FIELD_SPELL_ID] ?? '', 10)
    if (isNaN(spellId)) return
    this.emit(event, {
      casterGuid,
      casterName: sanitizeName(fields[SPELL_FIELD_CASTER_NAME]),
      casterFlags: parseHexFlags(fields[SPELL_FIELD_CASTER_FLAGS] ?? '0'),
      spellId,
      spellName: fields[SPELL_FIELD_SPELL_NAME] ?? '',
      timestamp
    })
  }

  private handleBuffChange(fields: string[], applied: boolean, timestamp: Date): void {
    if (fields[AURA_FIELD_TYPE] !== 'BUFF') return
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    if (targetGuid === undefined || !targetGuid.startsWith('Player-')) return
    const spellId = parseInt(fields[SPELL_FIELD_SPELL_ID] ?? '', 10)
    if (isNaN(spellId)) return
    this.emit('buffChange', {
      casterGuid: fields[SPELL_FIELD_CASTER_GUID] ?? '',
      targetGuid,
      spellId,
      spellName: fields[SPELL_FIELD_SPELL_NAME] ?? '',
      applied,
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

    const talents = parseCombatantInfoTalents(rawLine)

    this.emit('combatantInfo', { playerGuid, playerName, team, personalRating, specId, talents, timestamp })
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

  // The advanced-logging block names a unit and its owner (ownerGUID is all zeros for
  // unowned units). Recording player-owned ones lets resolveEffectiveCaster credit pets
  // that were summoned before the log started (hunter and warlock pets, mostly).
  private learnOwner(fields: string[], unitGuidIndex: number): void {
    const unitGuid = fields[unitGuidIndex]
    const ownerGuid = fields[unitGuidIndex + 1]
    if (unitGuid === undefined || ownerGuid === undefined) return
    if (!ownerGuid.startsWith('Player-') || unitGuid.startsWith('Player-')) return
    if (this.summonOwners.get(unitGuid) !== ownerGuid) this.summonOwners.set(unitGuid, ownerGuid)
  }

  private emitDamageDone(fields: string[], casterGuid: string, casterName: string, amount: number, timestamp: Date): void {
    if (isNaN(amount) || amount <= 0) return
    const effective = this.resolveEffectiveCaster(casterGuid, casterName)
    if (!effective.guid.startsWith('Player-')) return
    this.emit('damageDone', {
      casterGuid: effective.guid,
      casterName: effective.name,
      casterFlags: parseHexFlags(fields[SPELL_FIELD_CASTER_FLAGS] ?? '0'),
      amount,
      timestamp
    })
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

    // Emit heal amount event for ALL heals (including self) — used for healing done and
    // per-target healing-received tracking (death recap). Redirect pet/totem heals
    // (Healing Stream Totem, Earthliving, etc.) to their owning player.
    this.learnOwner(fields, SPELL_ADVANCED_UNIT_GUID)
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
        overhealing: Math.min(amount, parseOverhealing(fields)),
        timestamp
      })
    }
  }

  private handleSpellDamage(fields: string[], timestamp: Date): void {
    const casterGuid = fields[SPELL_FIELD_CASTER_GUID]
    const casterName = sanitizeName(fields[SPELL_FIELD_CASTER_NAME])
    const targetGuid = fields[SPELL_FIELD_TARGET_GUID]
    const targetName = sanitizeName(fields[SPELL_FIELD_TARGET_NAME])
    if (casterGuid === undefined || targetGuid === undefined) return

    // For SPELL_DAMAGE the advanced block describes the target
    this.learnOwner(fields, SPELL_ADVANCED_UNIT_GUID)

    if (!targetGuid.startsWith('Player-')) {
      this.emitDamageDone(fields, casterGuid, casterName, parseSpellDamageAmount(fields) - parseSpellOverkill(fields), timestamp)
      return
    }
    // spellDamage only tracks damage taken by players

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

    // For SWING_DAMAGE the advanced block describes the attacker, so this is how pets
    // summoned before logging started get tied to their owner
    this.learnOwner(fields, SWING_ADVANCED_UNIT_GUID)

    if (!targetGuid.startsWith('Player-')) {
      this.emitDamageDone(fields, casterGuid, casterName, parseSwingDamageAmount(fields) - parseSwingOverkill(fields), timestamp)
      return
    }

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
}

// ---------------------------------------------------------------------------
// Utility functions (module-private)
// ---------------------------------------------------------------------------

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

// Talent picks from the first bracket of a COMBATANT_INFO line:
// "[(62085,80141,1),(62086,80142,1),…]" → [[62085, 80141, 1], …]
function parseCombatantInfoTalents(line: string): Array<[number, number, number]> {
  const open = line.indexOf('[')
  const close = line.indexOf(']', open)
  if (open === -1 || close === -1) return []
  const talents: Array<[number, number, number]> = []
  for (const m of line.substring(open + 1, close).matchAll(/\((\d+),(\d+),(\d+)\)/g)) {
    talents.push([parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)])
  }
  return talents
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
