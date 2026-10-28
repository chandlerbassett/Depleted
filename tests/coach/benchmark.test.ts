import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareWithTop } from '../../src/shared/coachBenchmark'
import { BenchmarkService, type WclQuery } from '../../src/main/coach/BenchmarkService'
import type { Benchmark, BenchmarkRun } from '../../src/shared/benchmark.types'
import type { CoachData } from '../../src/shared/coach.types'

const DURATION = 600
const WRATH = 19574 // pressed every 30 s by top players
const COBRA = 193455 // filler, ~20 a minute
const EXHIL = 109304 // defensive, pressed whenever

function times(from: number, every: number, until: number): number[] {
  const out: number[] = []
  for (let t = from; t < until; t += every) out.push(t)
  return out
}

function topRun(i: number): BenchmarkRun {
  const casts: Array<[number, number]> = [
    ...times(12, 30, DURATION).map((t): [number, number] => [t, WRATH]),
    ...times(10, 3, DURATION).map((t): [number, number] => [t, COBRA]),
    ...[100, 130 + i * 20, 500].map((t): [number, number] => [t, EXHIL])
  ]
  return {
    name: `Top${i}`,
    server: 'Realm',
    region: 'US',
    amount: 400_000 + i * 1000,
    keyLevel: 15,
    durationSecs: DURATION,
    reportCode: `abc${i}`,
    fightId: 3,
    firstPull: 10,
    casts,
    gear: [],
    talents: []
  }
}

function bench(): Benchmark {
  return {
    version: 2,
    specId: 253,
    dungeon: 'Ruby Life Pools',
    encounterId: 112521,
    keyLevel: 15,
    metric: 'dps',
    fetchedAt: new Date().toISOString(),
    runs: Array.from({ length: 10 }, (_, i) => topRun(i)),
    spellNames: { [WRATH]: 'Bestial Wrath', [COBRA]: 'Cobra Shot', [EXHIL]: 'Exhilaration' },
    itemNames: {}
  }
}

function key(casts: Array<[number, number]>, gear?: number[], talents: Array<[number, number, number]> = []): CoachData {
  const damage = new Array<number>(DURATION).fill(0)
  for (let s = 20; s < DURATION; s++) damage[s] = 300_000
  return {
    version: 1,
    duration: DURATION,
    spellNames: {},
    players: [
      {
        guid: 'Player-1',
        name: 'Gobitron-Area52',
        specId: 253,
        talents,
        gear,
        casts,
        castStarts: [],
        buffs: [],
        damage,
        healing: new Array<number>(DURATION).fill(0),
        deaths: []
      }
    ]
  }
}

describe('compareWithTop', () => {
  it('learns which spells top players press on cooldown, and leaves defensives out', () => {
    const c = compareWithTop(key([[25, WRATH]]), 'Player-1', bench())!
    expect(c.cooldowns.map((cd) => cd.name)).toEqual(['Bestial Wrath'])
    expect(c.cooldowns[0]!.topUses).toBe(20)
    expect(c.cooldowns[0]!.topInterval).toBe(30)
    expect(c.output.top).toBe(404_500)
    expect(c.output.you).toBeCloseTo(290_000)
  })

  it('flags a cooldown pressed far less often, pointing at the longest wait', () => {
    // Every 60 s instead of every 30 s, plus a 3-minute hole
    const uses = [...times(22, 60, 200), ...times(380, 60, DURATION)]
    const c = compareWithTop(key(uses.map((t): [number, number] => [t, WRATH])), 'Player-1', bench())!
    const f = c.findings.find((x) => x.title.startsWith('Bestial Wrath'))!
    expect(f.title).toBe(`Bestial Wrath: ${uses.length} uses, top players ~20`)
    // Last use before the hole was at 142; ready again 30 s later
    expect(f.at).toBe(172)
    expect(f.detail).toContain('about every 30s')
  })

  it("notes a cooldown never pressed without telling the player to use it", () => {
    // It may be a trinket or talent the player doesn't have (issue #16)
    const never = compareWithTop(key([]), 'Player-1', bench())!
    expect(never.findings.filter((f) => f.title.includes('Bestial Wrath'))).toEqual([])
    expect(never.cooldowns.map((cd) => cd.name)).not.toContain('Bestial Wrath')
    expect(never.neverUsed.map((n) => n.name)).toContain('Bestial Wrath')
  })

  it('flags a late opener', () => {
    const late = times(60, 30, DURATION).map((t): [number, number] => [t, WRATH])
    const c = compareWithTop(key(late), 'Player-1', bench())!
    expect(c.findings.map((f) => f.title)).toContain('Late Bestial Wrath in the opener')
  })

  it('lists core spells cast much less than top players', () => {
    const casts = times(20, 30, DURATION).map((t): [number, number] => [t, WRATH])
    casts.push(...times(20, 20, DURATION).map((t): [number, number] => [t, COBRA]))
    const c = compareWithTop(key(casts), 'Player-1', bench())!
    expect(c.castMix.map((m) => m.name)).toEqual(['Cobra Shot'])
    expect(c.findings).toEqual([])
  })

  describe('spells never cast, matched to gear and talents (issue #20)', () => {
    const TRINKET = 219314 // on-use trinket 8 of 10 top runs wear
    const OTHER_TRINKET = 212456
    const ON_USE = 443124 // its spell
    const BURST = 359844 // a talented cooldown
    const TALENT = 128380 // the talent entry granting it

    // Runs 0-7 wear the trinket and press it every 90 s; 0-5 also take the talent
    function gearBench(): Benchmark {
      const b = bench()
      b.runs = b.runs.map((r, i) => {
        const casts = [...r.casts]
        if (i < 8) casts.push(...times(15, 90, DURATION).map((t): [number, number] => [t, ON_USE]))
        if (i < 6) casts.push(...times(16, 120, DURATION).map((t): [number, number] => [t, BURST]))
        return {
          ...r,
          casts,
          gear: [1000, 1001, i < 8 ? TRINKET : OTHER_TRINKET, 2000 + i],
          talents: [[90001, 100001], ...(i < 6 ? [[90002, TALENT] as [number, number]] : [])]
        }
      })
      b.spellNames[ON_USE] = 'Ara-Kara Sacbrood'
      b.spellNames[BURST] = 'Call of the Wild'
      b.itemNames = { [TRINKET]: 'Ara-Kara Sacbrood' }
      return b
    }

    it("says the player doesn't wear the trinket", () => {
      const c = compareWithTop(key([[25, WRATH]], [1000, 1001, OTHER_TRINKET], [[90001, 100001, 1]]), 'Player-1', gearBench())!
      const n = c.neverUsed.find((x) => x.spellId === ON_USE)!
      expect(n.source).toEqual({ kind: 'item', name: 'Ara-Kara Sacbrood', takenBy: 8, of: 10, has: false })
      expect(n.note).toBe("Ara-Kara Sacbrood comes from Ara-Kara Sacbrood, which you don't use. 8 of 10 top players do.")
      expect(c.findings.filter((f) => f.title.includes('Sacbrood'))).toEqual([])
      const t = c.neverUsed.find((x) => x.spellId === BURST)!
      expect(t.source).toMatchObject({ kind: 'talent', has: false, takenBy: 6 })
      expect(t.note).toBe("Call of the Wild comes from a talent you don't take. 6 of 10 top players do.")
    })

    it('flags a trinket or talent the player had and never pressed', () => {
      const c = compareWithTop(
        key([[25, WRATH]], [1000, 1001, TRINKET], [[90001, 100001, 1], [90002, TALENT, 1]]),
        'Player-1',
        gearBench()
      )!
      const trinket = c.findings.find((f) => f.title === 'Ara-Kara Sacbrood: never used')!
      expect(trinket.detail).toContain('You had Ara-Kara Sacbrood equipped and never pressed it')
      expect(trinket.at).toBe(20)
      expect(c.findings.find((f) => f.title === 'Call of the Wild: never used')!.detail).toContain('You had the talent for it')
      expect(c.neverUsed.every((n) => n.note === null)).toBe(true)
    })

    it('names the source without judging when the recording has no gear', () => {
      const c = compareWithTop(key([[25, WRATH]]), 'Player-1', gearBench())!
      const n = c.neverUsed.find((x) => x.spellId === ON_USE)!
      expect(n.source).toMatchObject({ kind: 'item', has: null })
      expect(n.note).toBe('Ara-Kara Sacbrood comes from Ara-Kara Sacbrood (8 of 10 top players have it).')
    })

    it('keeps the old side note when every top run casts it', () => {
      // Bestial Wrath: all runs cast it, so nothing tells items and talents apart
      const c = compareWithTop(key([], [1000, 1001, TRINKET]), 'Player-1', gearBench())!
      const n = c.neverUsed.find((x) => x.spellId === WRATH)!
      expect(n.source).toEqual({ kind: 'unknown' })
      expect(n.note).toBeNull()
    })
  })

  it('needs enough top runs', () => {
    const b = bench()
    b.runs = b.runs.slice(0, 3)
    expect(compareWithTop(key([]), 'Player-1', b)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BenchmarkService against a fake WCL
// ---------------------------------------------------------------------------

class FakeWcl implements WclQuery {
  calls: string[] = []
  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(query)
    if (query.includes('expansions')) {
      return {
        worldData: {
          expansions: [
            {
              id: 7,
              zones: [
                { id: 56, name: 'Mythic+ Season 2 (PTR)', frozen: true, encounters: [{ id: 1, name: 'Ruby Life Pools' }] },
                { id: 55, name: 'Mythic+ Season 2', frozen: false, encounters: [{ id: 112521, name: 'Ruby Life Pools' }] }
              ]
            }
          ]
        }
      } as T
    }
    if (query.includes('characterRankings')) {
      // Bracket N holds +(N+1) keys
      const level = (variables.bracket as number) + 1
      return {
        worldData: {
          encounter: {
            characterRankings: {
              rankings: Array.from({ length: 4 }, (_, i) => ({
                name: `P${level}x${i}`,
                amount: 100 + i,
                hardModeLevel: level,
                duration: 1_200_000,
                report: { code: `R${level}x${i}`, fightID: 2 },
                server: { name: 'Realm', region: 'US' }
              }))
            }
          }
        }
      } as T
    }
    if (query.includes('masterData')) {
      const out: Record<string, unknown> = {}
      for (const [, alias, name] of query.matchAll(/(r\d+): reportData \{ report\(code: "R(\d+x\d+)"/g)) {
        out[alias!] = {
          report: {
            fights: [{ startTime: 1000, friendlyPlayers: [7] }],
            masterData: { actors: [{ id: 7, name: `P${name}`, subType: 'Hunter' }] }
          }
        }
      }
      return out as T
    }
    if (query.includes('dataType: Casts')) {
      const out: Record<string, unknown> = {}
      for (const [, alias] of query.matchAll(/(e\d+): reportData/g)) {
        out[alias!] = {
          report: {
            casts: {
              data: [
                { timestamp: 21000, type: 'cast', abilityGameID: WRATH },
                { timestamp: 21500, type: 'begincast', abilityGameID: COBRA }
              ],
              nextPageTimestamp: null
            },
            dmg: { data: [{ timestamp: 20000, type: 'damage', abilityGameID: 1 }], nextPageTimestamp: null },
            info: {
              data: [
                {
                  type: 'combatantinfo',
                  gear: [{ id: 219314, name: 'Ara-Kara Sacbrood' }, { id: 0 }, { id: 212456 }],
                  talentTree: [{ id: 128380, rank: 1, nodeID: 90002 }]
                }
              ]
            }
          }
        }
      }
      return out as T
    }
    if (query.includes('item(id')) return { i212456: { item: { id: 212456, name: 'Signet of the Priory' } } } as T
    if (query.includes('gameData')) return { [`s${WRATH}`]: { ability: { id: WRATH, name: 'Bestial Wrath' } } } as T
    throw new Error(`unexpected query ${query}`)
  }
}

describe('BenchmarkService', () => {
  it('widens to nearby key levels until it has enough runs, then caches', async () => {
    const wcl = new FakeWcl()
    const dir = mkdtempSync(join(tmpdir(), 'bench-'))
    const svc = new BenchmarkService(wcl, dir)
    const b = await svc.get(253, "Ruby Life Pools", 15)

    expect(b.encounterId).toBe(112521)
    // 4 runs a level: +15, +14, +16, +13 → 15 runs, same level first
    expect(b.runs).toHaveLength(15)
    expect(b.runs.slice(0, 4).every((r) => r.keyLevel === 15)).toBe(true)
    expect(new Set(b.runs.map((r) => r.keyLevel))).toEqual(new Set([13, 14, 15, 16]))
    // Fight-relative seconds; begincasts dropped
    expect(b.runs[0]!.casts).toEqual([[20, WRATH]])
    expect(b.runs[0]!.firstPull).toBe(19)
    expect(b.spellNames[WRATH]).toBe('Bestial Wrath')
    // Gear and talents from CombatantInfo; item names from it or from gameData
    expect(b.runs[0]!.gear).toEqual([219314, 0, 212456])
    expect(b.runs[0]!.talents).toEqual([[90002, 128380]])
    expect(b.itemNames).toEqual({ 219314: 'Ara-Kara Sacbrood', 212456: 'Signet of the Priory' })
    expect(wcl.calls.find((q) => q.includes('dataType: CombatantInfo'))).toBeDefined()

    const before = wcl.calls.length
    await new BenchmarkService(wcl, dir).get(253, 'Ruby Life Pools', 15)
    // A fresh service only looks up the dungeon again; runs come from the cache
    expect(wcl.calls.length - before).toBe(1)
  })

  it('says when WCL has no rankings for the dungeon', async () => {
    const svc = new BenchmarkService(new FakeWcl(), mkdtempSync(join(tmpdir(), 'bench-')))
    await expect(svc.get(253, 'Nowhere Keep', 15)).rejects.toThrow('no Mythic+ rankings for Nowhere Keep')
  })
})
