// Which class a player is, for class colours in the replay view.
//
// Several spec names belong to more than one class (Holy: Paladin and Priest; Frost:
// Mage and Death Knight; Restoration: Druid and Shaman; Protection: Paladin and
// Warrior), so a spec name alone can't say the class. The class comes from the spec ID
// COMBATANT_INFO logged, and the spec name is only used when it names one class.

import { WOW_SPEC_ID_MAP } from './constants'

// Spec name → class, only for spec names no other class shares
export const UNIQUE_SPEC_NAME_TO_CLASS: Readonly<Record<string, string>> = (() => {
  const classes = new Map<string, Set<string>>()
  for (const entry of Object.values(WOW_SPEC_ID_MAP)) {
    const set = classes.get(entry.spec) ?? new Set<string>()
    set.add(entry.class)
    classes.set(entry.spec, set)
  }
  const map: Record<string, string> = {}
  for (const [spec, set] of classes) if (set.size === 1) map[spec] = [...set][0]!
  return map
})()

// name → class from the players' spec IDs (coach.json), for recordings saved before
// metadata.knownClasses existed
export function classesFromSpecIds(players: ReadonlyArray<{ name: string; specId: number | null }>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const p of players) {
    const cls = p.specId !== null ? WOW_SPEC_ID_MAP[p.specId]?.class : undefined
    if (cls !== undefined) map[p.name] = cls
  }
  return map
}

export interface PlayerClassSources {
  // From COMBATANT_INFO spec IDs (metadata.knownClasses, or coach.json for older recordings)
  knownClasses?: Readonly<Record<string, string>>
  // From class-specific spells the player cast
  spellClasses?: ReadonlyMap<string, string>
  // name → spec name (metadata.knownSpecs)
  knownSpecs?: Readonly<Record<string, string>>
}

export function resolvePlayerClass(name: string, sources: PlayerClassSources): string | undefined {
  return (
    sources.knownClasses?.[name] ??
    sources.spellClasses?.get(name) ??
    UNIQUE_SPEC_NAME_TO_CLASS[sources.knownSpecs?.[name] ?? '']
  )
}
