import { describe, it, expect } from 'vitest'
import { CombatLogParser, UNIT_FLAG_REACTION_HOSTILE } from '../../src/main/combatlog/CombatLogParser'
import type {
  UnitDiedEvent,
  ZoneChangedEvent,
  CombatantInfoEvent,
  SpellDamageEvent,
  SpellHealAmountEvent,
  ParserEventMap
} from '../../src/main/combatlog/CombatLogParser'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function feedLines(parser: CombatLogParser, lines: string[]): void {
  for (const line of lines) {
    parser.processLine(line)
  }
}

// ---------------------------------------------------------------------------
// Zone changes and deaths
// ---------------------------------------------------------------------------

describe('CombatLogParser — zones and deaths', () => {
  it('emits zoneChanged for every ZONE_CHANGE', () => {
    const parser = new CombatLogParser()
    const events: ZoneChangedEvent[] = []
    parser.on('zoneChanged', (e) => events.push(e))

    parser.processLine('10/27/2026 20:00:00.0000  ZONE_CHANGE,2660,"Ara-Kara, City of Echoes",8')

    expect(events).toHaveLength(1)
    expect(events[0]!.instanceId).toBe(2660)
    expect(events[0]!.zoneName).toBe('Ara-Kara, City of Echoes')
  })

  it('emits unitDied with destFlags parsed from hex', () => {
    const parser = new CombatLogParser()
    const events: UnitDiedEvent[] = []
    parser.on('unitDied', (e) => events.push(e))

    parser.processLine(
      '10/27/2026 20:01:13.0000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1329-0A000001,"Tankguy-Illidan-US",0x548,0x0,0'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.unitName).toBe('Tankguy-Illidan-US')
    expect(events[0]!.unitGuid).toBe('Player-1329-0A000001')
    expect((events[0]!.destFlags & UNIT_FLAG_REACTION_HOSTILE) !== 0).toBe(true)
  })
})

describe('CombatLogParser — robustness', () => {
  it('silently ignores empty lines', () => {
    const parser = new CombatLogParser()
    expect(() => parser.processLine('')).not.toThrow()
  })

  it('silently ignores lines without double-space separator', () => {
    const parser = new CombatLogParser()
    expect(() => parser.processLine('not a valid log line')).not.toThrow()
  })

  it('silently ignores unknown event types', () => {
    const parser = new CombatLogParser()
    expect(() => parser.processLine('4/15 20:00:00.000  UNKNOWN_EVENT,some,data')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// COMBATANT_INFO — spec ID field position
// ---------------------------------------------------------------------------
// specID is the LAST plain stat field before the FIRST '[' (talents bracket) —
// verified against real Midnight combat logs. A prior version of the parser read it
// from the trailing section after the LAST ']' instead, which is a different field
// entirely and silently produced wrong/garbage spec IDs for every recording.

describe('CombatLogParser — COMBATANT_INFO spec ID', () => {
  it('reads specId from the stat block before the talents bracket, not the trailing fields', () => {
    const parser = new CombatLogParser()
    const events: CombatantInfoEvent[] = []
    parser.on('combatantInfo', (e) => events.push(e))

    // Structurally real (redacted GUID/name): stat block ending in specId=64 (Frost
    // Mage), then talents/pvp-talents/covenant/gear/aura brackets, then trailing
    // [garbage, unk, personalRating, honorLevel] after the last ']'.
    parser.processLine(
      '4/15/2026 20:00:00.0000  COMBATANT_INFO,Player-000-00000001,1,306,470,22231,2744,0,0,0,0,0,0,0,98,0,' +
        '1006,1006,1006,0,157,1229,1229,1229,702,64,' +
        '[(62084,80140,1)],(0,410248,1220739,415945),[(250060,289,(7991,0,0),(13448),(213748,610))],' +
        '[Player-000-00000001,1459,1],78,41,2407,0'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.specId).toBe(64)
    expect(events[0]!.personalRating).toBe(2407)
    expect(events[0]!.talents).toEqual([[62084, 80140, 1]])
  })

  it('returns specId null when the stat block is empty or malformed', () => {
    const parser = new CombatLogParser()
    const events: CombatantInfoEvent[] = []
    parser.on('combatantInfo', (e) => events.push(e))

    parser.processLine(
      '4/15/2026 20:00:00.0000  COMBATANT_INFO,Player-000-00000002,0,[(1,2,3)],78,41,1600,0'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.specId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SPELL_DAMAGE / SWING_DAMAGE / SPELL_HEAL — amount field position
// ---------------------------------------------------------------------------
// Advanced Combat Logging (required by this app) inserts a ~17-field "advanced"
// metadata block (unitGUID, ownerGUID, currentHP, maxHP, ...) between the spell
// prefix and the damage/heal suffix. A prior version of this parser assumed a fixed
// forward offset for the amount field, which actually pointed at the advanced
// block's unitGUID (a string, parses to NaN) — silently dropping every single
// damage/heal event whenever ACL was on. Verified against ~2000 real Midnight combat
// log lines per event type that the field COUNT is stable (SPELL_DAMAGE/
// SPELL_PERIODIC_DAMAGE = 41, SWING_DAMAGE = 37, SPELL_HEAL/SPELL_PERIODIC_HEAL = 35),
// so the amount is read from a fixed offset from the END of the fields array instead.

describe('CombatLogParser — SPELL_DAMAGE/SWING_DAMAGE/SPELL_HEAL amount (with Advanced Combat Logging)', () => {
  it('reads the damage amount from a real ACL-enabled SPELL_DAMAGE line', () => {
    const parser = new CombatLogParser()
    const events: SpellDamageEvent[] = []
    parser.on('spellDamage', (e) => events.push(e))

    parser.processLine(
      '4/15/2026 22:35:20.0143  SPELL_DAMAGE,Player-000-00000001,"Attacker-Realm-EU",0x548,0x80000000,' +
        'Player-000-00000002,"Victim-Realm-EU",0x511,0x80000000,331850,"Blade Flurry",0x1,' +
        'Player-000-00000002,0000000000000000,445976,451840,279,2654,710,2272,0,0,0,235420,250000,0,' +
        '1277.96,1645.59,0,0.6261,283,5864,7724,-1,1,0,0,0,nil,nil,nil,AOE'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.amount).toBe(5864)
    expect(events[0]!.spellName).toBe('Blade Flurry')
  })

  it('reads the damage amount from a real ACL-enabled SWING_DAMAGE line', () => {
    const parser = new CombatLogParser()
    const events: SpellDamageEvent[] = []
    parser.on('spellDamage', (e) => events.push(e))

    parser.processLine(
      '4/15/2026 22:35:21.5693  SWING_DAMAGE,Player-000-00000001,"Attacker-Realm-EU",0x548,0x80000000,' +
        'Player-000-00000002,"Victim-Realm-EU",0x511,0x80000000,Player-000-00000001,0000000000000000,' +
        '539700,539700,2569,486,840,2816,0,18099,3,189,250,0,1274.52,1644.24,0,1.6829,283,5341,7036,-1,1,0,0,0,nil,nil,nil'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.amount).toBe(5341)
    expect(events[0]!.spellName).toBe('Auto Attack')
  })

  it('reads the heal amount from a real ACL-enabled SPELL_HEAL line', () => {
    const parser = new CombatLogParser()
    const events: SpellHealAmountEvent[] = []
    parser.on('spellHealAmount', (e) => events.push(e))

    parser.processLine(
      '4/15/2026 22:35:08.5553  SPELL_HEAL,Player-000-00000003,"Healer-Realm-EU",0x548,0x80000000,' +
        'Player-000-00000004,"Ally-Realm-EU",0x548,0x80000000,1246798,"Prompt Prognosis",0x2,' +
        'Player-000-00000004,0000000000000000,464560,464560,279,2633,697,2072,0,21037,0,250000,250000,0,' +
        '1280.27,1724.28,0,4.5710,283,41687,41687,41687,0,nil'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.amount).toBe(41687)
    expect(events[0]!.spellName).toBe('Prompt Prognosis')
  })
})

// ---------------------------------------------------------------------------
// Pet/totem caster → owning player attribution (SPELL_SUMMON tracking)
// ---------------------------------------------------------------------------
// Pets/totems report their own GUID+name as the caster in SPELL_DAMAGE/SPELL_HEAL/
// SWING_DAMAGE lines, not their owner's. SPELL_SUMMON (fired once, when the player
// creates the pet/totem) is the only reliable way to map the summon's GUID back to
// its owner — verified against a real "Healing Stream Totem" SPELL_SUMMON + SPELL_HEAL
// pair from a live combat log.

describe('CombatLogParser — pet/totem damage and healing attributed to the owning player', () => {
  it('attributes a totem SPELL_HEAL to the shaman that summoned it', () => {
    const parser = new CombatLogParser()
    const events: SpellHealAmountEvent[] = []
    parser.on('spellHealAmount', (e) => events.push(e))

    // SPELL_SUMMON: shaman creates the totem
    parser.processLine(
      '4/15/2026 13:20:32.5563  SPELL_SUMMON,Player-1329-0A8F89B9,"Orthonar-Ravencrest-EU",0x20548,0x80000000,' +
        'Creature-0-3111-1134-11204-3527-00005F6670,"Healing Stream Totem",0xa28,0x80000000,5394,"Healing Stream Totem",0x8'
    )
    // SPELL_HEAL: the totem itself heals someone (verified real line structure)
    parser.processLine(
      '4/15/2026 13:20:33.0000  SPELL_HEAL,Creature-0-3111-1134-11204-3527-00005F6670,"Healing Stream Totem",0x2148,0x80000000,' +
        'Player-3682-0B06A16E,"Toste-Ragnaros-EU",0x548,0x80000000,458357,"Chain Heal",0x8,' +
        'Player-3682-0B06A16E,0000000000000000,495000,495000,2733,696,864,2253,0,0,3,120,120,0,' +
        '-10683.34,457.92,0,3.6224,284,4229,4229,4229,0,nil'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.casterName).toBe('Orthonar-Ravencrest-EU')
    expect(events[0]!.casterGuid).toBe('Player-1329-0A8F89B9')
  })

  it('falls back to the summon\'s own name when no SPELL_SUMMON was observed for it', () => {
    const parser = new CombatLogParser()
    const events: SpellHealAmountEvent[] = []
    parser.on('spellHealAmount', (e) => events.push(e))

    // No SPELL_SUMMON seen (e.g. pet summoned before the log started) — should keep
    // the totem's own identity rather than crash or drop the event.
    parser.processLine(
      '4/15/2026 13:20:33.0000  SPELL_HEAL,Creature-0-3111-1134-11204-3527-00005F6670,"Healing Stream Totem",0x2148,0x80000000,' +
        'Player-3682-0B06A16E,"Toste-Ragnaros-EU",0x548,0x80000000,458357,"Chain Heal",0x8,' +
        'Player-3682-0B06A16E,0000000000000000,495000,495000,2733,696,864,2253,0,0,3,120,120,0,' +
        '-10683.34,457.92,0,3.6224,284,4229,4229,4229,0,nil'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.casterName).toBe('Healing Stream Totem')
  })
})

// ---------------------------------------------------------------------------
// "nil" caster/target names — WoW's own Lua null literal
// ---------------------------------------------------------------------------
// WoW writes the literal (unquoted) string nil for some fields it can't resolve a
// real value for (commonly seen on certain DoT ticks whose original caster is no
// longer trackable) — this must not leak through as a phantom "nil" player.

describe('CombatLogParser — "nil" caster/target names are treated as absent', () => {
  it('does not emit spellDamage with casterName "nil"', () => {
    const parser = new CombatLogParser()
    const events: SpellDamageEvent[] = []
    parser.on('spellDamage', (e) => events.push(e))

    parser.processLine(
      '4/15/2026 22:35:20.0143  SPELL_DAMAGE,Player-000-00000001,nil,0x548,0x80000000,' +
        'Player-000-00000002,"Victim-Realm-EU",0x511,0x80000000,331850,"Blade Flurry",0x1,' +
        'Player-000-00000002,0000000000000000,445976,451840,279,2654,710,2272,0,0,0,235420,250000,0,' +
        '1277.96,1645.59,0,0.6261,283,5864,7724,-1,1,0,0,0,nil,nil,nil,AOE'
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.casterName).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Damage done to mobs (Mythic+ DPS meter) — lines from a real 12.x key
// ---------------------------------------------------------------------------

describe('CombatLogParser — damage done to mobs', () => {
  const HUNTER = 'Player-3676-0EBBAA81'
  const MOB = 'Creature-0-4229-3095-213-272687-000060BD8A,"Shadowspeaker Ip\'thosh",0x10a48,0x80000000'
  const lines = {
    autoShot: `10/27/2026 11:08:10.973-4  RANGE_DAMAGE,${HUNTER},"Gobitron-Area52-US",0x511,0x80000000,${MOB},75,"Auto Shot",0x1,Creature-0-4229-3095-213-272687-000060BD8A,0000000000000000,43287914,43388700,0,0,1470,0,0,0,0,10312,10312,0,1484.17,-276.06,2670,3.1183,92,17289,23980,-1,1,0,0,0,nil,nil,nil,ST`,
    moonfire: `10/27/2026 11:08:08.987-4  SPELL_DAMAGE,Player-3675-0AEBA165,"Rikumita-MoonGuard-US",0x40514,0x80000000,${MOB},164812,"Moonfire",0x40,Creature-0-4229-3095-213-272687-000060BD8A,0000000000000000,43384284,43388700,0,0,1470,0,0,0,0,10312,10312,0,1484.17,-276.06,2670,3.1416,92,4416,4287,-1,64,0,0,0,nil,nil,nil,ST`,
    // Pet summoned before the log started: its owner is only known from the advanced block
    petSwing: `10/27/2026 11:08:13.640-4  SWING_DAMAGE,Pet-0-4209-2916-6-165189-0105533B2B,"Maeveish",0x1111,0x80000000,${MOB},Pet-0-4209-2916-6-165189-0105533B2B,${HUNTER},771998,771998,2384,2384,3326,0,0,0,2,100,100,0,1479.65,-274.91,2670,6.0350,333,1996,2768,-1,1,0,0,0,nil,nil,nil`,
    petSpell: `10/27/2026 11:08:14.776-4  SPELL_DAMAGE,Pet-0-4209-2916-6-165189-0105533B2B,"Maeveish",0x1111,0x80000000,${MOB},344572,"Bestial Wrath",0x1,Creature-0-4229-3095-213-272687-000060BD8A,0000000000000000,43163452,43388700,0,0,1470,0,0,0,0,10312,10312,0,1484.17,-276.06,2670,3.1183,92,77000,50318,-1,1,0,0,0,1,nil,nil,ST`,
    killingBlow: `10/27/2026 11:08:15.000-4  SPELL_DAMAGE,Player-3675-0AEBA165,"Rikumita-MoonGuard-US",0x40514,0x80000000,${MOB},164812,"Moonfire",0x40,Creature-0-4229-3095-213-272687-000060BD8A,0000000000000000,0,43388700,0,0,1470,0,0,0,0,10312,10312,0,1484.17,-276.06,2670,3.1416,92,5000,4287,1200,64,0,0,0,nil,nil,nil,ST`
  }

  it('emits damageDone for players and their pets, net of overkill, without touching spellDamage', () => {
    const parser = new CombatLogParser()
    const done: { casterName: string; amount: number }[] = []
    const playerDamage: SpellDamageEvent[] = []
    parser.on('damageDone', (e) => done.push({ casterName: e.casterName, amount: e.amount }))
    parser.on('spellDamage', (e) => playerDamage.push(e))

    feedLines(parser, Object.values(lines))

    expect(done).toEqual([
      { casterName: 'Gobitron-Area52-US', amount: 17289 },
      { casterName: 'Rikumita-MoonGuard-US', amount: 4416 },
      { casterName: 'Gobitron-Area52-US', amount: 1996 },
      { casterName: 'Gobitron-Area52-US', amount: 77000 },
      { casterName: 'Rikumita-MoonGuard-US', amount: 3800 }
    ])
    expect(playerDamage).toHaveLength(0)
  })

  it('reports overhealing on heals', () => {
    const parser = new CombatLogParser()
    const heals: SpellHealAmountEvent[] = []
    parser.on('spellHealAmount', (e) => heals.push(e))
    parser.processLine(
      `10/27/2026 11:08:13.220-4  SPELL_HEAL,Player-3676-0EBEE14D,"Satyshamy-Area52-US",0x514,0x80000000,Pet-0-4209-2916-6-165189-0105533B2B,"Maeveish",0x1111,0x80000000,73921,"Healing Rain",0x8,Pet-0-4209-2916-6-165189-0105533B2B,${HUNTER},771998,771998,2384,2384,3326,0,0,0,2,100,100,0,1477.63,-273.45,2670,5.6553,333,15160,15160,15000,0,1`
    )
    expect(heals).toHaveLength(1)
    expect(heals[0]!.amount).toBe(15160)
    expect(heals[0]!.overhealing).toBe(15000)
  })
})

// Line layouts copied from a 12.x M+ log (COMBAT_LOG_VERSION 22, Advanced Combat Logging on)
describe('CombatLogParser — casts and buffs for the coach', () => {
  it('emits spellCast for a player SPELL_CAST_SUCCESS, with the advanced block after it', () => {
    const parser = new CombatLogParser()
    const casts: ParserEventMap['spellCast'][] = []
    parser.on('spellCast', (e) => casts.push(e))

    parser.processLine(
      '10/27/2026 11:08:11.749-4  SPELL_CAST_SUCCESS,Player-3676-0EBBAA81,"Gobitron-Area52-US",0x511,0x80000000,' +
        '0000000000000000,nil,0x80000000,0x80000000,19574,"Bestial Wrath",0x1,Player-3676-0EBBAA81,0000000000000000,' +
        '1000322,1000322,3974,523,1663,559,817,0,2,100,100,0,1451.46,-277.46,2670,6.2682,333'
    )
    // Pet casts aren't the player's button presses
    parser.processLine(
      '10/27/2026 11:08:10.915-4  SPELL_CAST_SUCCESS,Pet-0-4209-2916-6-165189-0105533B2B,"Maeveish",0x1111,0x80000000,' +
        '0000000000000000,nil,0x80000000,0x80000000,61684,"Dash",0x1,Pet-0-4209-2916-6-165189-0105533B2B,' +
        'Player-3676-0EBBAA81,771998,771998,2384,2384,3326,0,0,0,2,100,100,0,1445.64,-274.53,2670,6.14'
    )

    expect(casts).toHaveLength(1)
    expect(casts[0]).toMatchObject({
      casterGuid: 'Player-3676-0EBBAA81',
      casterName: 'Gobitron-Area52-US',
      spellId: 19574,
      spellName: 'Bestial Wrath'
    })
  })

  it('emits spellCastStart for SPELL_CAST_START', () => {
    const parser = new CombatLogParser()
    const starts: ParserEventMap['spellCastStart'][] = []
    parser.on('spellCastStart', (e) => starts.push(e))

    parser.processLine(
      '10/27/2026 11:12:51.950-4  SPELL_CAST_START,Player-3676-0EBBAA81,"Gobitron-Area52-US",0x511,0x80000000,' +
        '0000000000000000,nil,0x80000000,0x80000000,125050,"Fetch",0x1'
    )

    expect(starts).toHaveLength(1)
    expect(starts[0]!.spellId).toBe(125050)
  })

  it('emits buffChange for buffs on players and skips debuffs', () => {
    const parser = new CombatLogParser()
    const buffs: ParserEventMap['buffChange'][] = []
    parser.on('buffChange', (e) => buffs.push(e))

    parser.processLine(
      '10/27/2026 11:08:13.148-4  SPELL_AURA_REMOVED,Player-3676-0EBBAA81,"Gobitron-Area52-US",0x511,0x80000000,' +
        'Player-3676-0EBBAA81,"Gobitron-Area52-US",0x511,0x80000000,471878,"Howl of the Pack Leader",0x1,BUFF'
    )
    parser.processLine(
      '10/27/2026 11:08:14.000-4  SPELL_AURA_APPLIED,Player-3676-0EBBAA81,"Gobitron-Area52-US",0x511,0x80000000,' +
        'Creature-0-4229-3095-213-272687-000060BD8A,"Shadowspeaker Ip\'thosh",0x10a48,0x80000000,257284,"Hunter\'s Mark",0x8,DEBUFF'
    )

    expect(buffs).toEqual([
      expect.objectContaining({
        casterGuid: 'Player-3676-0EBBAA81',
        targetGuid: 'Player-3676-0EBBAA81',
        spellId: 471878,
        applied: false
      })
    ])
  })
})
