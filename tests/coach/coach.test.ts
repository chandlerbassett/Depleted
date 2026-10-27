import { describe, it, expect } from 'vitest'
import { CoachCollector } from '../../src/main/coach/CoachCollector'
import { detectPulls, reviewPlayer } from '../../src/shared/coachAnalysis'
import type { CoachData, CoachPlayer } from '../../src/shared/coach.types'

// ---------------------------------------------------------------------------
// CoachCollector
// ---------------------------------------------------------------------------

describe('CoachCollector', () => {
  it('shifts key time to video time and buckets damage per second', () => {
    const c = new CoachCollector()
    c.setCombatant('Player-1', 'Ann-Realm', 253, [[1, 2, 1]])
    c.addCast('Player-1', 'Ann-Realm', 19574, 'Bestial Wrath', 12.5)
    c.addCast('Player-1', 'Ann-Realm', 100, 'Before video', 1)
    c.addBuff('Player-1', 19574, 'Bestial Wrath', true, 12.5)
    c.addBuff('Player-1', 19574, 'Bestial Wrath', false, 27.5)
    c.addDamage('Player-1', 'Ann-Realm', 300, 12.2)
    c.addDamage('Player-1', 'Ann-Realm', 200, 12.9)
    c.addDeath('Player-1', 'Ann-Realm', 40)

    // Video started 2 s after the key
    const data = c.build(2, 60)
    const p = data.players[0]!

    expect(p.specId).toBe(253)
    expect(p.talents).toEqual([[1, 2, 1]])
    expect(p.casts).toEqual([[10.5, 19574]])
    expect(p.buffs).toEqual([[19574, 10.5, 25.5]])
    expect(p.damage[10]).toBe(500)
    expect(p.damage).toHaveLength(60)
    expect(p.deaths).toEqual([38])
    expect(data.spellNames[19574]).toBe('Bestial Wrath')
  })

  it('closes buffs still up when the key ends', () => {
    const c = new CoachCollector()
    c.addCast('Player-1', 'Ann-Realm', 1, 'Thing', 5)
    c.addBuff('Player-1', 1, 'Thing', true, 50)
    expect(c.build(0, 60).players[0]!.buffs).toEqual([[1, 50, 60]])
  })
})

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const DURATION = 400

function player(guid: string, overrides: Partial<CoachPlayer> = {}): CoachPlayer {
  return {
    guid,
    name: `${guid}-Realm`,
    specId: 253, // Beast Mastery
    talents: [],
    casts: [],
    castStarts: [],
    buffs: [],
    damage: new Array<number>(DURATION).fill(0),
    healing: new Array<number>(DURATION).fill(0),
    deaths: [],
    ...overrides
  }
}

// Fighting from 10 s to 390 s, one cast every 1.5 s
function busyPlayer(guid: string): CoachPlayer {
  const p = player(guid)
  for (let s = 10; s < 390; s++) p.damage[s] = 1000
  for (let t = 10; t < 390; t += 1.5) p.casts.push([t, 1])
  return p
}

function coach(players: CoachPlayer[]): CoachData {
  return { version: 1, duration: DURATION, spellNames: { 1: 'Filler', 2: 'Big Cooldown', 3: 'Wall' }, players }
}

describe('coach analysis', () => {
  it('finds pulls from party damage, merging short gaps', () => {
    const p = player('A')
    for (let s = 10; s < 50; s++) p.damage[s] = 100
    for (let s = 53; s < 80; s++) p.damage[s] = 100 // 3 s gap: same pull
    for (let s = 200; s < 205; s++) p.damage[s] = 100 // too short to count
    expect(detectPulls(coach([p]))).toEqual([{ start: 10, end: 80 }])
  })

  it('reports gaps with no casts inside pulls as downtime', () => {
    const p = busyPlayer('A')
    p.casts = p.casts.filter(([t]) => t < 100 || t > 110)
    const review = reviewPlayer(coach([p]), 'A')!
    expect(review.downtime).toHaveLength(1)
    expect(review.downtime[0]!.start).toBe(98.5)
    expect(review.downtime[0]!.secs).toBeGreaterThan(10)
    expect(review.findings[0]).toMatchObject({ kind: 'downtime' })
  })

  it("doesn't count time spent dead as downtime", () => {
    const p = busyPlayer('A')
    p.specId = 70 // Retribution — no Feign Death
    p.casts = p.casts.filter(([t]) => t < 100 || t > 130)
    p.deaths = [101]
    const review = reviewPlayer(coach([p]), 'A')!
    expect(review.downtime).toHaveLength(0)
    expect(review.deaths).toHaveLength(1)
  })

  it('ignores a Hunter death that casts again within seconds (Feign Death)', () => {
    const p = busyPlayer('A')
    p.deaths = [100.2]
    expect(reviewPlayer(coach([p]), 'A')!.deaths).toHaveLength(0)
  })

  it('flags a throughput cooldown that sat ready during pulls', () => {
    const p = busyPlayer('A')
    // Big Cooldown: used at 20, 80 and 300 (so ready again at 140), triples damage
    for (const t of [20, 80, 300]) {
      p.casts.push([t, 2])
      p.buffs.push([2, t, t + 15])
      for (let s = t; s < t + 15; s++) p.damage[s] = 3000
    }
    p.casts.sort((a, b) => a[0] - b[0])

    const review = reviewPlayer(coach([p]), 'A')!
    const cd = review.cooldowns.find((c) => c.spellId === 2)!
    expect(cd.throughput).toBe(true)
    expect(cd.estCooldown).toBe(60)
    expect(cd.held).toEqual([{ readyAt: 140, usedAt: 300, secs: 160 }, { readyAt: 360, usedAt: null, secs: 30 }])
    expect(review.findings[0]).toMatchObject({ kind: 'cooldown', at: 140 })
  })

  it("doesn't judge a defensive for sitting unused, but lists it as ready at a death", () => {
    const p = busyPlayer('A')
    p.specId = 70
    // Wall: no damage gain, used at 30 and 150
    for (const t of [30, 150]) {
      p.casts.push([t, 3])
      p.buffs.push([3, t, t + 8])
    }
    p.casts.sort((a, b) => a[0] - b[0])
    p.casts = p.casts.filter(([t]) => t < 300 || t > 330)
    p.deaths = [300]

    const review = reviewPlayer(coach([p]), 'A')!
    const wall = review.cooldowns.find((c) => c.spellId === 3)!
    expect(wall.throughput).toBe(false)
    expect(wall.held).toEqual([])
    expect(review.deaths[0]!.readyCooldowns).toEqual(['Wall'])
  })

  it('flags stretches where the player falls well behind their usual share', () => {
    const a = busyPlayer('A')
    const b = busyPlayer('B')
    for (let s = 120; s < 150; s++) a.damage[s] = 100
    const review = reviewPlayer(coach([a, b]), 'A')!
    expect(review.lowStretches.map((w) => w.start)).toEqual([120])
  })

  it('uses healing for healers and skips the damage-share check', () => {
    const p = busyPlayer('A')
    p.specId = 264 // Restoration Shaman
    const review = reviewPlayer(coach([p]), 'A')!
    expect(review.metric).toBe('healing')
    expect(review.lowStretches).toEqual([])
    expect(review.findings.filter((f) => f.kind === 'cooldown')).toEqual([])
  })
})
