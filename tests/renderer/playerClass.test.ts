import { describe, it, expect } from 'vitest'
import { UNIQUE_SPEC_NAME_TO_CLASS, classesFromSpecIds, resolvePlayerClass } from '../../src/shared/playerClass'

describe('player class', () => {
  it('leaves out spec names that more than one class shares', () => {
    for (const shared of ['Holy', 'Frost', 'Restoration', 'Protection']) {
      expect(UNIQUE_SPEC_NAME_TO_CLASS[shared]).toBeUndefined()
    }
    expect(UNIQUE_SPEC_NAME_TO_CLASS['Beast Mastery']).toBe('Hunter')
    expect(UNIQUE_SPEC_NAME_TO_CLASS['Arms']).toBe('Warrior')
  })

  it('reads classes from spec IDs', () => {
    expect(
      classesFromSpecIds([
        { name: 'Justice-Uther-US', specId: 65 },
        { name: 'Priesty-Uther-US', specId: 257 },
        { name: 'Fejao-Stormrage-US', specId: 251 },
        { name: 'Icy-Stormrage-US', specId: 64 },
        { name: 'Unknown-Uther-US', specId: null }
      ])
    ).toEqual({
      'Justice-Uther-US': 'Paladin',
      'Priesty-Uther-US': 'Priest',
      'Fejao-Stormrage-US': 'Death Knight',
      'Icy-Stormrage-US': 'Mage'
    })
  })

  it('prefers the logged class, then spells cast, then an unambiguous spec name', () => {
    const knownSpecs = { 'Justice-Uther-US': 'Holy', 'Gobitron-Area52-US': 'Beast Mastery' }
    expect(resolvePlayerClass('Justice-Uther-US', { knownSpecs })).toBeUndefined()
    expect(resolvePlayerClass('Justice-Uther-US', { knownSpecs, knownClasses: { 'Justice-Uther-US': 'Paladin' } })).toBe('Paladin')
    expect(
      resolvePlayerClass('Justice-Uther-US', { knownSpecs, spellClasses: new Map([['Justice-Uther-US', 'Paladin']]) })
    ).toBe('Paladin')
    expect(resolvePlayerClass('Gobitron-Area52-US', { knownSpecs })).toBe('Hunter')
  })
})
