import { describe, it, expect } from 'vitest'
import { buildCharacterStatsUrl, normalizeStatsSite, realmSlug } from '../../src/renderer/src/utils/characterLinks'

describe('realmSlug', () => {
  it('turns combat log realm names into site slugs', () => {
    expect(realmSlug('MoonGuard')).toBe('moon-guard')
    expect(realmSlug('Area52')).toBe('area-52')
    expect(realmSlug("Mal'Ganis")).toBe('malganis')
    expect(realmSlug("Kel'Thuzad")).toBe('kelthuzad')
    expect(realmSlug('Ravencrest')).toBe('ravencrest')
    expect(realmSlug('TwistingNether')).toBe('twisting-nether')
  })
})

describe('buildCharacterStatsUrl', () => {
  it('builds Raider.IO URLs', () => {
    expect(buildCharacterStatsUrl('raiderio', "Jakerator-Mal'Ganis-US", 'eu')).toBe(
      'https://raider.io/characters/us/malganis/Jakerator'
    )
  })

  it('builds Warcraft Logs URLs', () => {
    expect(buildCharacterStatsUrl('warcraftlogs', 'Rikumita-MoonGuard-US', 'eu')).toBe(
      'https://www.warcraftlogs.com/character/us/moon-guard/rikumita'
    )
  })

  it('builds Armory URLs', () => {
    expect(buildCharacterStatsUrl('armory', 'Gobitron-Area52-US', 'eu')).toBe(
      'https://worldofwarcraft.blizzard.com/en-us/character/us/area-52/gobitron'
    )
  })

  it('encodes non-ASCII names for Raider.IO', () => {
    expect(buildCharacterStatsUrl('raiderio', 'Crítícäl-Ravencrest-EU', 'us')).toBe(
      'https://raider.io/characters/eu/ravencrest/Cr%C3%ADt%C3%ADc%C3%A4l'
    )
  })

  it('falls back to the default region when the combat log name has no region suffix', () => {
    expect(buildCharacterStatsUrl('raiderio', 'Crítícäl-Ravencrest', 'us')).toContain('/characters/us/ravencrest/')
  })
})

describe('normalizeStatsSite', () => {
  it('maps a saved PvP site to Raider.IO', () => {
    expect(normalizeStatsSite('checkpvp')).toBe('raiderio')
    expect(normalizeStatsSite(undefined)).toBe('raiderio')
    expect(normalizeStatsSite('warcraftlogs')).toBe('warcraftlogs')
  })
})
