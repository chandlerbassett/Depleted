import { describe, it, expect } from 'vitest'
import { reviewPlayer } from '../../src/shared/coachAnalysis'
import { compareWithTop } from '../../src/shared/coachBenchmark'
import {
  recapKey,
  summarizeKey,
  summarizeBosses,
  buildTrends,
  buildBossTrends,
  direction,
  repeatsIn,
  type KeySummary
} from '../../src/shared/coachRecap'
import type { Benchmark, BenchmarkRun } from '../../src/shared/benchmark.types'
import type { CoachData } from '../../src/shared/coach.types'

const DURATION = 600
const WRATH = 19574
const COBRA = 193455

function times(from: number, every: number, until: number): number[] {
  const out: number[] = []
  for (let t = from; t < until; t += every) out.push(t)
  return out
}

function topRun(i: number): BenchmarkRun {
  return {
    name: `Top${i}`,
    server: 'Realm',
    region: 'US',
    amount: 400_000,
    keyLevel: 15,
    durationSecs: DURATION,
    reportCode: `abc${i}`,
    fightId: 3,
    firstPull: 10,
    casts: [
      ...times(12, 30, DURATION).map((t): [number, number] => [t, WRATH]),
      ...times(10, 3, DURATION).map((t): [number, number] => [t, COBRA])
    ],
    gear: [],
    talents: []
  }
}

const bench: Benchmark = {
  version: 2,
  specId: 253,
  dungeon: 'Ruby Life Pools',
  encounterId: 112521,
  keyLevel: 15,
  metric: 'dps',
  fetchedAt: '2026-10-27T00:00:00Z',
  runs: Array.from({ length: 10 }, (_, i) => topRun(i)),
  spellNames: { [WRATH]: 'Bestial Wrath', [COBRA]: 'Cobra Shot' },
  itemNames: {}
}

// A key fought from 20 s to the end. wrathEvery: how often the player pressed Bestial
// Wrath; idle: a 20 s gap with no casts; died: a death at 300 s
function key(opts: { wrathEvery: number; idle?: boolean; died?: boolean }): CoachData {
  const damage = new Array<number>(DURATION).fill(0)
  for (let s = 20; s < DURATION; s++) damage[s] = 200_000
  const casts: Array<[number, number]> = [
    ...times(22, opts.wrathEvery, DURATION).map((t): [number, number] => [t, WRATH]),
    ...times(20, 2.5, DURATION)
      .filter((t) => !opts.idle || t < 200 || t > 220)
      // Down for a while, so it isn't read as Feign Death
      .filter((t) => !opts.died || t < 300 || t > 315)
      .map((t): [number, number] => [t, COBRA])
  ].sort((a, b) => a[0] - b[0])
  return {
    version: 1,
    duration: DURATION,
    spellNames: { [WRATH]: 'Bestial Wrath', [COBRA]: 'Cobra Shot' },
    players: [
      {
        guid: 'Player-1',
        name: 'Gobitron-Area52',
        specId: 253,
        talents: [],
        casts,
        castStarts: [],
        buffs: [],
        damage,
        healing: new Array<number>(DURATION).fill(0),
        deaths: opts.died ? [300] : []
      }
    ]
  }
}

function summary(n: number, data: CoachData, benchmarked = true): KeySummary {
  const review = reviewPlayer(data, 'Player-1')!
  const comparison = benchmarked ? compareWithTop(data, 'Player-1', bench) : null
  return summarizeKey(
    { recordingId: `rec${n}`, date: `2026-10-${String(10 + n).padStart(2, '0')}T20:00:00Z`, dungeon: 'Ruby Life Pools', keyLevel: 15 },
    review,
    comparison
  )
}

describe('recapKey', () => {
  it('ranks own-key and top-player issues together, each with moments', () => {
    const data = key({ wrathEvery: 90, idle: true, died: true })
    const review = reviewPlayer(data, 'Player-1')!
    const recap = recapKey(review, compareWithTop(data, 'Player-1', bench))

    const issues = recap.issues.map((i) => i.issue)
    expect(issues).toContain('death')
    expect(issues).toContain('downtime')
    expect(issues).toContain(`cd-uses:${WRATH}`)
    for (const i of recap.issues) expect(i.moments.length).toBeGreaterThan(0)

    const wrath = recap.issues.find((i) => i.issue === `cd-uses:${WRATH}`)!
    expect(wrath.label).toBe('Bestial Wrath used less than top players')
    expect(wrath.fromTop).toBe(true)
    expect(recap.headline).toMatch(/^DPS at 48% of the top runs\. Active \d+% of the fighting, \d+s idle, 1 death\.$/)
  })

  it('still recaps without top players to compare with', () => {
    const review = reviewPlayer(key({ wrathEvery: 30, died: true }), 'Player-1')!
    const recap = recapKey(review, null)
    expect(recap.outputPct).toBeNull()
    expect(recap.issues.map((i) => i.issue)).toEqual(['death'])
    expect(recap.headline).not.toContain('DPS')
  })
})

describe('trends', () => {
  it('reads recent keys against earlier ones', () => {
    expect(direction([3, 3, 3])).toBeNull()
    expect(direction([60, 50, 20, 10])).toBe('improving')
    expect(direction([10, 10, 40, 50])).toBe('worse')
    expect(direction([30, 30, 28, 32])).toBe('steady')
  })

  it('finds issues that repeat across keys and whether they are improving', () => {
    // Bestial Wrath used ever more often across six keys
    const keys = [90, 90, 75, 60, 45, 30].map((every, i) => summary(i, key({ wrathEvery: every, idle: i < 2 })))
    const trends = buildTrends([...keys].reverse())

    expect(trends.keys.map((k) => k.recordingId)).toEqual(['rec0', 'rec1', 'rec2', 'rec3', 'rec4', 'rec5'])
    const wrath = trends.issues.find((t) => t.issue === `cd-uses:${WRATH}`)!
    expect(wrath.of).toBe(6)
    expect(wrath.keys.length).toBeGreaterThanOrEqual(3)
    expect(wrath.keys[0]!.recordingId > wrath.keys[1]!.recordingId).toBe(true)
    expect(wrath.direction).toBe('improving')

    // Idle only in the first two keys: gone lately
    const idle = trends.issues.find((t) => t.issue === 'downtime')!
    expect(idle.keys.map((k) => k.recordingId)).toEqual(['rec1', 'rec0'])
    expect(idle.lately).toBe('clear')
  })

  it('only counts keys compared with top players for top-player issues', () => {
    const keys = [
      summary(0, key({ wrathEvery: 90 })),
      summary(1, key({ wrathEvery: 90 }), false),
      summary(2, key({ wrathEvery: 90 }))
    ]
    const wrath = buildTrends(keys).issues.find((t) => t.issue === `cd-uses:${WRATH}`)!
    expect(wrath.of).toBe(2)
  })

  it('tags a recap issue that came up in earlier keys', () => {
    const earlier = [summary(0, key({ wrathEvery: 90 })), summary(1, key({ wrathEvery: 30 }))]
    expect(repeatsIn(`cd-uses:${WRATH}`, true, earlier, '2026-10-20T00:00:00Z')).toEqual({ count: 1, of: 2 })
    expect(repeatsIn('death', false, earlier, '2026-10-20T00:00:00Z')).toBeNull()
    // Keys after this one don't count
    expect(repeatsIn(`cd-uses:${WRATH}`, true, earlier, '2026-10-05T00:00:00Z')).toBeNull()
  })
})

// Two players: Gobitron does half the party's damage, except during the boss at
// 100-160 s, where they do a quarter and stop casting for 20 s
function bossKey(slack: boolean): CoachData {
  const data = key({ wrathEvery: 30 })
  const me = data.players[0]!
  const partner = { ...me, guid: 'Player-2', name: 'Friend-Area52', casts: [], deaths: [], damage: [...me.damage] }
  if (slack) {
    for (let s = 100; s < 160; s++) me.damage[s] = 200_000 / 3
    me.casts = me.casts.filter(([t]) => t < 120 || t > 140)
  }
  data.players.push(partner)
  return data
}

const BOSS = { encounterId: 2918, name: 'Kokia Blazehoof', start: 100, end: 160, success: true }

function bossSummary(n: number, slack: boolean): KeySummary {
  const data = bossKey(slack)
  const review = reviewPlayer(data, 'Player-1')!
  return summarizeKey(
    { recordingId: `rec${n}`, date: `2026-10-${String(10 + n).padStart(2, '0')}T20:00:00Z`, dungeon: 'Ruby Life Pools', keyLevel: 15 },
    review,
    compareWithTop(data, 'Player-1', bench),
    summarizeBosses(data, review, [BOSS])
  )
}

describe('boss fights', () => {
  it('measures the player in each boss fight against the whole key', () => {
    const [boss] = bossSummary(0, true).bosses
    expect(boss!.name).toBe('Kokia Blazehoof')
    expect(boss!.sharePct).toBeCloseTo(25, 0)
    expect(boss!.keySharePct).toBeGreaterThan(45)
    expect(boss!.activePct).toBeLessThan(75)
    expect(boss!.at).toBe(100)
  })

  it('flags a boss the player keeps falling off on', () => {
    const [trend] = buildBossTrends([bossSummary(0, true), bossSummary(1, true)])
    expect(trend!.keys).toBe(2)
    expect(trend!.attempts.map((a) => a.recordingId)).toEqual(['rec1', 'rec0'])
    expect(trend!.notes.join(' ')).toMatch(/share of the party's output drops to \d+%/)
    expect(trend!.notes.join(' ')).toMatch(/You cast \d+% of the time here/)
  })

  it('says nothing about a boss that goes like the rest of the key', () => {
    const [trend] = buildBossTrends([bossSummary(0, false), bossSummary(1, false)])
    expect(trend!.notes).toEqual([])
  })

  it('needs the fight in two keys', () => {
    expect(buildBossTrends([bossSummary(0, true)])).toEqual([])
  })

  it('counts cooldown uses against what top players fit in', () => {
    // Top players press Bestial Wrath every 30 s; this player every 90 s
    const k = summary(0, key({ wrathEvery: 90 }))
    expect(k.cdUsePct).toBeGreaterThan(25)
    expect(k.cdUsePct).toBeLessThan(45)
    expect(summary(1, key({ wrathEvery: 90 }), false).cdUsePct).toBeNull()
  })
})
