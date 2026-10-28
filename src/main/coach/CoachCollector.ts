// Gathers the per-player data the coach needs while a key is recording: casts, self
// buffs, damage and healing per second, deaths, talents and gear. MythicPlusStateMachine
// feeds it party members only and calls build() when the key ends.

import type { CoachData, CoachPlayer } from '@shared/coach.types'

interface PlayerAcc {
  guid: string
  name: string
  specId: number | null
  talents: Array<[number, number, number]>
  gear: number[]
  casts: Array<[number, number]>
  castStarts: number[]
  buffs: Array<[number, number, number]>
  // spellId → start of a buff that's currently up
  openBuffs: Map<number, number>
  damage: Map<number, number>
  healing: Map<number, number>
  deaths: number[]
}

export class CoachCollector {
  private readonly players = new Map<string, PlayerAcc>()
  private readonly spellNames = new Map<number, string>()

  setCombatant(
    guid: string,
    name: string,
    specId: number | null,
    talents: Array<[number, number, number]>,
    gear: number[] = []
  ): void {
    const p = this.player(guid, name)
    if (specId !== null) p.specId = specId
    if (talents.length > 0) p.talents = talents
    if (gear.some((id) => id > 0)) p.gear = gear
  }

  addCast(guid: string, name: string, spellId: number, spellName: string, relSecs: number): void {
    this.player(guid, name).casts.push([relSecs, spellId])
    this.nameSpell(spellId, spellName)
  }

  addCastStart(guid: string, name: string, relSecs: number): void {
    this.player(guid, name).castStarts.push(relSecs)
  }

  // Only self buffs (caster = target) are passed in
  addBuff(guid: string, spellId: number, spellName: string, applied: boolean, relSecs: number): void {
    const p = this.players.get(guid)
    if (p === undefined) return
    if (applied) {
      if (!p.openBuffs.has(spellId)) p.openBuffs.set(spellId, relSecs)
      this.nameSpell(spellId, spellName)
      return
    }
    const start = p.openBuffs.get(spellId)
    if (start === undefined) return
    p.openBuffs.delete(spellId)
    p.buffs.push([spellId, start, relSecs])
  }

  addDamage(guid: string, name: string, amount: number, relSecs: number): void {
    bump(this.player(guid, name).damage, relSecs, amount)
  }

  addHealing(guid: string, name: string, amount: number, relSecs: number): void {
    bump(this.player(guid, name).healing, relSecs, amount)
  }

  addDeath(guid: string, name: string, relSecs: number): void {
    this.player(guid, name).deaths.push(relSecs)
  }

  // Key-relative times → video times: the video starts leadSecs after the key did.
  build(leadSecs: number, durationSecs: number): CoachData {
    const t = (secs: number): number => Math.round((secs - leadSecs) * 100) / 100
    const inVideo = (secs: number): boolean => secs >= 0 && secs <= durationSecs
    const seconds = Math.ceil(durationSecs)

    const players: CoachPlayer[] = []
    for (const p of this.players.values()) {
      if (!p.name) continue
      const buffs = [...p.buffs]
      for (const [spellId, start] of p.openBuffs) buffs.push([spellId, start, durationSecs + leadSecs])
      players.push({
        guid: p.guid,
        name: p.name,
        specId: p.specId,
        talents: p.talents,
        gear: p.gear,
        casts: p.casts.map(([s, id]): [number, number] => [t(s), id]).filter(([s]) => inVideo(s)),
        castStarts: p.castStarts.map(t).filter(inVideo),
        buffs: buffs
          .map(([id, s, e]): [number, number, number] => [id, Math.max(0, t(s)), Math.min(durationSecs, t(e))])
          .filter(([, s, e]) => e > s)
          .sort((a, b) => a[1] - b[1]),
        damage: perSecond(p.damage, leadSecs, seconds),
        healing: perSecond(p.healing, leadSecs, seconds),
        deaths: p.deaths.map(t).filter(inVideo)
      })
    }

    return {
      version: 1,
      duration: durationSecs,
      spellNames: Object.fromEntries(this.spellNames),
      players
    }
  }

  private player(guid: string, name: string): PlayerAcc {
    let p = this.players.get(guid)
    if (p === undefined) {
      p = {
        guid,
        name,
        specId: null,
        talents: [],
        gear: [],
        casts: [],
        castStarts: [],
        buffs: [],
        openBuffs: new Map(),
        damage: new Map(),
        healing: new Map(),
        deaths: []
      }
      this.players.set(guid, p)
    } else if (!p.name && name) {
      p.name = name
    }
    return p
  }

  private nameSpell(spellId: number, spellName: string): void {
    if (spellName && !this.spellNames.has(spellId)) this.spellNames.set(spellId, spellName)
  }
}

function bump(map: Map<number, number>, relSecs: number, amount: number): void {
  const sec = Math.floor(relSecs)
  map.set(sec, (map.get(sec) ?? 0) + amount)
}

// Key-second buckets → a dense per-video-second array
function perSecond(map: Map<number, number>, leadSecs: number, seconds: number): number[] {
  const out = new Array<number>(seconds).fill(0)
  const shift = Math.round(leadSecs)
  for (const [sec, amount] of map) {
    const i = sec - shift
    if (i >= 0 && i < seconds) out[i] = (out[i] ?? 0) + Math.round(amount)
  }
  return out
}
