// Boss abilities and phase markers for a raid pull's timeline, worked out from the
// combat log alone (no per-boss data).
//
// The boss is every hostile unit at the highest level seen in the pull: raid bosses log
// as max player level + 3 (93 in Midnight) and so do the units that are part of the
// encounter (a second boss, an exposed weak point), while adds sit a level or two lower.
// The level only comes with Advanced Combat Logging, on SPELL_CAST_SUCCESS; without it a
// unit named after the encounter is taken as the boss.
//
// Phases come from boss emotes (RAID_BOSS_EMOTE: "exposes her Venomous Heart", "circles
// her prey, preparing for the final strike") and from part of the boss dying mid-pull.

import type { TimelineEvent } from '@shared/ipc.types'
import { BOSS_ABILITY_MERGE_SECS, BOSS_CAST_MAX_SECS } from '@shared/constants'

interface BossCast {
  relSecs: number
  guid: string
  name: string
  spellId: number
  spellName: string
  isStart: boolean
}

interface BossEmote {
  relSecs: number
  guid: string
  name: string
  text: string
}

interface HostileDeath {
  relSecs: number
  guid: string
  name: string
}

// A death this close to the end of the pull is the kill itself, not a phase
const END_OF_PULL_SECS = 3
// The same emote text again within this long (a boss repeating a warning) is one marker
const EMOTE_REPEAT_SECS = 10
// Emotes with no unit behind them
const NO_UNIT_GUID = '0000000000000000'

export class BossMechanicsCollector {
  private readonly casts: BossCast[] = []
  private readonly levels = new Map<string, number>()
  private readonly emotes: BossEmote[] = []
  private readonly deaths: HostileDeath[] = []

  constructor(private readonly encounterName: string) {}

  addCast(cast: BossCast, level: number | undefined): void {
    this.casts.push(cast)
    if (level !== undefined) this.levels.set(cast.guid, level)
  }

  addEmote(emote: BossEmote): void {
    this.emotes.push(emote)
  }

  addDeath(death: HostileDeath): void {
    this.deaths.push(death)
  }

  // Times are pull seconds, like the rest of the session timeline
  build(pullEndRelSecs: number, killed = false): TimelineEvent[] {
    const isBoss = this.bossTest()
    return [...this.abilities(isBoss), ...this.phases(isBoss, pullEndRelSecs, killed)]
  }

  // A unit we know the level of, below the boss's: an add
  private isKnownAdd(guid: string): boolean {
    const level = this.levels.get(guid)
    return level !== undefined && level < Math.max(...this.levels.values())
  }

  private bossTest(): (guid: string, name: string) => boolean {
    if (this.levels.size === 0) return (_guid, name) => name === this.encounterName
    const bossLevel = Math.max(...this.levels.values())
    return (guid) => this.levels.get(guid) === bossLevel
  }

  private abilities(isBoss: (guid: string, name: string) => boolean): TimelineEvent[] {
    const casts = this.casts.filter((c) => isBoss(c.guid, c.name))
    const kept: BossCast[] = []
    // Casts arrive in log order: the last START of each unit's spell, and the last marker
    // kept for each ability
    const lastStart = new Map<string, number>()
    const lastKept = new Map<string, number>()
    for (const cast of casts) {
      const key = `${cast.guid}:${cast.spellId}`
      if (cast.isStart) {
        lastStart.set(key, cast.relSecs)
      } else {
        // A hard cast logs START then SUCCESS: mark it once, when it starts
        const startedAt = lastStart.get(key)
        if (startedAt !== undefined && cast.relSecs - startedAt <= BOSS_CAST_MAX_SECS) continue
      }
      // Several boss units casting it together or one after another (both bosses, a wave
      // of spawned copies) is one mechanic. Measured from the last marker kept, so an
      // ability cast every few seconds still gets a marker every few seconds.
      const previous = lastKept.get(cast.spellName)
      if (previous !== undefined && cast.relSecs - previous < BOSS_ABILITY_MERGE_SECS) continue
      lastKept.set(cast.spellName, cast.relSecs)
      kept.push(cast)
    }
    return kept.map((c) => ({
      timestamp: c.relSecs,
      type: 'boss-ability',
      spellId: c.spellId,
      spellName: c.spellName,
      casterName: c.name,
      target: 'enemy'
    }))
  }

  private phases(
    isBoss: (guid: string, name: string) => boolean,
    pullEndRelSecs: number,
    killed: boolean
  ): TimelineEvent[] {
    // The boss's own emotes. A unit we never saw a level for may still be the boss (it
    // only emotes), so only units known to be adds, and emotes with no unit, are left out.
    const lastText = new Map<string, number>()
    const fromEmotes: TimelineEvent[] = []
    for (const e of this.emotes) {
      if (e.guid === NO_UNIT_GUID || e.guid === '' || this.isKnownAdd(e.guid)) continue
      if (this.levels.size === 0 && !isBoss(e.guid, e.name)) continue
      const text = cleanEmote(e.text)
      if (text === '') continue
      const previous = lastText.get(text)
      lastText.set(text, e.relSecs)
      if (previous !== undefined && e.relSecs - previous < EMOTE_REPEAT_SECS) continue
      fromEmotes.push({ timestamp: e.relSecs, type: 'phase', unit: e.name, text })
    }

    const bossDeaths = this.deaths.filter((d) => isBoss(d.guid, d.name))
    // On a kill the last boss death is the kill, however long before ENCOUNTER_END it was
    if (killed) bossDeaths.pop()
    const fromDeaths: TimelineEvent[] = bossDeaths
      .filter((d) => pullEndRelSecs - d.relSecs > END_OF_PULL_SECS)
      .map((d) => ({ timestamp: d.relSecs, type: 'phase', unit: d.name, text: `${d.name} dies`, target: 'enemy' }))
    return [...fromEmotes, ...fromDeaths]
  }
}

// Emote text is UI markup: |T<icon>|t textures, |A<atlas>|a icons, |cAARRGGBB…|r
// colours, |Hspell:<id>|h[Name]|h links and |n line breaks. Keep only the words.
export function cleanEmote(raw: string): string {
  return raw
    .replace(/\|T[^|]*\|t/g, '')
    .replace(/\|A[^|]*\|a/g, '')
    .replace(/\|n/g, ' ')
    .replace(/\|H[^|]*\|h\[?([^\]|]*)\]?\|h/g, '$1')
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
