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
export function classesFromSpecIds(players: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  if (!Array.isArray(players)) return map
  for (const p of players as Array<{ name?: unknown; specId?: unknown } | null>) {
    if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.specId !== 'number') continue
    const spec = own(WOW_SPEC_ID_MAP, p.specId)
    if (spec !== undefined) map[p.name] = spec.class
  }
  return map
}

// A table entry only when the key is the table's own (a crafted name like
// "constructor" must not read Object.prototype)
export function own<T>(table: Readonly<Record<string | number, T>> | undefined, key: string | number): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
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
  const fromLog = own(sources.knownClasses, name)
  if (typeof fromLog === 'string') return fromLog
  const fromSpells = sources.spellClasses?.get(name)
  if (fromSpells !== undefined) return fromSpells
  const spec = own(sources.knownSpecs, name)
  return typeof spec === 'string' ? own(UNIQUE_SPEC_NAME_TO_CLASS, spec) : undefined
}
