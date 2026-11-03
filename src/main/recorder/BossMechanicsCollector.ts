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
  build(pullEndRelSecs: number): TimelineEvent[] {
    const isBoss = this.bossTest()
    return [...this.abilities(isBoss), ...this.phases(isBoss, pullEndRelSecs)]
  }

  private bossTest(): (guid: string, name: string) => boolean {
    if (this.levels.size === 0) return (_guid, name) => name === this.encounterName
    const bossLevel = Math.max(...this.levels.values())
    return (guid) => this.levels.get(guid) === bossLevel
  }

  private abilities(isBoss: (guid: string, name: string) => boolean): TimelineEvent[] {
    const casts = this.casts.filter((c) => isBoss(c.guid, c.name))
    const kept: BossCast[] = []
    const lastSeen = new Map<string, number>()
    for (const cast of casts) {
      // A hard cast logs START then SUCCESS: mark it once, when it starts
      const started =
        !cast.isStart &&
        casts.some(
          (o) =>
            o.isStart &&
            o.guid === cast.guid &&
            o.spellId === cast.spellId &&
            cast.relSecs >= o.relSecs &&
            cast.relSecs - o.relSecs <= BOSS_CAST_MAX_SECS
        )
      if (started) continue
      // Several boss units casting it together or one after another (both bosses, a wave
      // of spawned copies) is one mechanic
      const previous = lastSeen.get(cast.spellName)
      lastSeen.set(cast.spellName, cast.relSecs)
      if (previous !== undefined && cast.relSecs - previous < BOSS_ABILITY_MERGE_SECS) continue
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

  private phases(isBoss: (guid: string, name: string) => boolean, pullEndRelSecs: number): TimelineEvent[] {
    const fromEmotes: TimelineEvent[] = this.emotes
      .map((e) => ({ ...e, text: cleanEmote(e.text) }))
      .filter((e) => e.text !== '')
      .map((e) => ({ timestamp: e.relSecs, type: 'phase', unit: e.name, text: e.text }))
    const fromDeaths: TimelineEvent[] = this.deaths
      .filter((d) => isBoss(d.guid, d.name) && pullEndRelSecs - d.relSecs > END_OF_PULL_SECS)
      .map((d) => ({ timestamp: d.relSecs, type: 'phase', unit: d.name, text: `${d.name} dies`, target: 'enemy' }))
    return [...fromEmotes, ...fromDeaths]
  }
}

// Emote text is UI markup: |T<icon>|t textures, |cAARRGGBB…|r colours and
// |Hspell:<id>|h[Name]|h links. Keep only the words.
export function cleanEmote(raw: string): string {
  return raw
    .replace(/\|T[^|]*\|t/g, '')
    .replace(/\|H[^|]*\|h\[?([^\]|]*)\]?\|h/g, '$1')
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
