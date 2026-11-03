import { describe, it, expect } from 'vitest'
import { BossMechanicsCollector, cleanEmote } from '../../src/main/recorder/BossMechanicsCollector'

const BOSS = 'Vehicle-0-4239-3004-90005-257758-000068E8BA'
const CO_BOSS = 'Vehicle-0-4239-3004-90005-259555-000068E8F7'
const ADD = 'Creature-0-4239-3004-90005-261915-000068E950'

function cast(relSecs: number, guid: string, name: string, spellId: number, spellName: string, isStart: boolean) {
  return { relSecs, guid, name, spellId, spellName, isStart }
}

describe('BossMechanicsCollector', () => {
  it('marks each boss cast once, when it starts, and leaves out the adds', () => {
    const c = new BossMechanicsCollector("Ula'tek")
    c.addCast(cast(22, BOSS, "Ula'tek", 1298367, "Mother's Wrath", true), undefined)
    c.addCast(cast(27, BOSS, "Ula'tek", 1298367, "Mother's Wrath", false), 93)
    c.addCast(cast(30, BOSS, "Ula'tek", 1301007, 'Unchecked Rage', false), 93)
    c.addCast(cast(31, ADD, 'Blightscale Viper', 1301800, 'Acidic Burst', true), undefined)
    c.addCast(cast(32, ADD, 'Blightscale Viper', 1301800, 'Acidic Burst', false), 92)

    expect(c.build(400).map((e) => [e.type, e.timestamp, e.spellName, e.casterName])).toEqual([
      ['boss-ability', 22, "Mother's Wrath", "Ula'tek"],
      ['boss-ability', 30, 'Unchecked Rage', "Ula'tek"]
    ])
  })

  it('merges the same ability from two boss units cast together', () => {
    const c = new BossMechanicsCollector("Ula'tek")
    c.addCast(cast(50, BOSS, "Ula'tek", 1319282, 'Caustic Waves', true), undefined)
    c.addCast(cast(50, CO_BOSS, 'Gore Rattle', 1298570, 'Caustic Waves', true), undefined)
    c.addCast(cast(56, BOSS, "Ula'tek", 1319282, 'Caustic Waves', false), 93)
    c.addCast(cast(56, CO_BOSS, 'Gore Rattle', 1298570, 'Caustic Waves', false), 93)
    c.addCast(cast(107, BOSS, "Ula'tek", 1319282, 'Caustic Waves', true), undefined)

    expect(c.build(400).map((e) => e.timestamp)).toEqual([50, 107])
  })

  it('falls back to the unit named after the encounter without Advanced Combat Logging', () => {
    const c = new BossMechanicsCollector("Ula'tek")
    c.addCast(cast(10, BOSS, "Ula'tek", 1304012, 'Call of the Serpent', true), undefined)
    c.addCast(cast(12, ADD, 'Blightscale Viper', 1301800, 'Acidic Burst', true), undefined)

    expect(c.build(400).map((e) => e.spellName)).toEqual(['Call of the Serpent'])
  })

  it('marks phases from boss emotes and from part of the boss dying mid-pull, not the kill', () => {
    const c = new BossMechanicsCollector('Council')
    const other = 'Vehicle-0-1-1-1-111-0001'
    c.addCast(cast(5, BOSS, 'First', 1, 'Smash', false), 93)
    c.addCast(cast(6, other, 'Second', 2, 'Bash', false), 93)
    c.addEmote({ relSecs: 146, guid: BOSS, name: 'First', text: 'First summons her wardens!' })
    c.addDeath({ relSecs: 200, guid: other, name: 'Second' })
    c.addDeath({ relSecs: 210, guid: ADD, name: 'Blightscale Viper' })
    c.addDeath({ relSecs: 399, guid: BOSS, name: 'First' })

    expect(c.build(400).filter((e) => e.type === 'phase').map((e) => [e.timestamp, e.text])).toEqual([
      [146, 'First summons her wardens!'],
      [200, 'Second dies']
    ])
  })
})

describe('cleanEmote', () => {
  it('strips icons, colours and spell links from boss emote text', () => {
    expect(
      cleanEmote(
        "|TInterface\\ICONS\\INV_Misc_Organ_02.blp:20|t Ula'tek rages and exposes her |cFFFF0000|Hspell:1299526|h[Venomous Heart]|h|r!"
      )
    ).toBe("Ula'tek rages and exposes her Venomous Heart!")
  })
})
