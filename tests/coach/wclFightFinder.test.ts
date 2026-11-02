import { describe, it, expect, vi } from 'vitest'
import { WclFightFinder, matchFight, parseRankings, type FightToFind } from '../../src/main/coach/WclFightFinder'

const REPORT_START = Date.UTC(2026, 10, 2, 19, 0, 0)
const PULL_AT = new Date(REPORT_START + 1_800_000)

const TARGET: FightToFind = {
  startedAt: PULL_AT,
  encounterId: 3129,
  characters: [{ name: 'Raider', serverSlug: 'twisting-nether', region: 'EU' }]
}

const FIGHTS = [
  { id: 4, encounterID: 3129, startTime: 600_000, endTime: 840_000, keystoneLevel: null },
  { id: 7, encounterID: 0, startTime: 1_790_000, endTime: 1_799_000, keystoneLevel: null },
  { id: 8, encounterID: 3129, startTime: 1_801_500, endTime: 2_100_000, keystoneLevel: null },
  { id: 9, encounterID: 3130, startTime: 1_800_000, endTime: 2_000_000, keystoneLevel: null }
]

const RANKINGS = {
  data: [
    {
      fightID: 8,
      roles: {
        tanks: { characters: [{ name: 'Tanky', spec: 'Protection', amount: 120000, rankPercent: 64.2 }] },
        healers: { characters: [{ name: 'Healy', spec: 'Holy', amount: 900000, rankPercent: 99.1 }] },
        dps: { characters: [{ name: 'Raider', spec: 'Fire', amount: 1500000 }] }
      }
    }
  ]
}

describe('matchFight', () => {
  it('picks the pull of the same boss that started closest to the recording', () => {
    expect(matchFight(FIGHTS, REPORT_START, TARGET)?.id).toBe(8)
  })

  it('finds nothing when no pull of that boss started near the recording', () => {
    expect(matchFight(FIGHTS, REPORT_START, { ...TARGET, startedAt: new Date(REPORT_START + 3_600_000) })).toBeNull()
  })

  it('matches a key as the keystone run', () => {
    const fights = [...FIGHTS, { id: 12, encounterID: 12660, startTime: 1_799_000, endTime: 3_500_000, keystoneLevel: 14 }]
    expect(matchFight(fights, REPORT_START, { ...TARGET, encounterId: null })?.id).toBe(12)
  })
})

describe('parseRankings', () => {
  it('reads each role, with no percentile where WCL has none', () => {
    expect(parseRankings(RANKINGS)).toEqual([
      { name: 'Tanky', spec: 'Protection', role: 'tank', amount: 120000, percent: 64.2 },
      { name: 'Healy', spec: 'Holy', role: 'healer', amount: 900000, percent: 99.1 },
      { name: 'Raider', spec: 'Fire', role: 'dps', amount: 1500000, percent: null }
    ])
  })

  it('copes with a fight WCL has not ranked', () => {
    expect(parseRankings({ data: [] })).toEqual([])
    expect(parseRankings(null)).toEqual([])
  })
})

describe('WclFightFinder.find', () => {
  it('links the fight from a report covering the recording', async () => {
    const query = vi.fn(async (q: string) => {
      if (q.includes('recentReports')) {
        return {
          characterData: {
            character: {
              recentReports: {
                data: [
                  { code: 'old111', title: 'Last week', startTime: REPORT_START - 604_800_000, endTime: REPORT_START - 590_000_000 },
                  { code: 'abc123', title: 'Heroic night', startTime: REPORT_START, endTime: REPORT_START + 10_000_000 }
                ]
              }
            }
          }
        }
      }
      if (q.includes('rankings')) return { reportData: { report: { rankings: RANKINGS } } }
      return { reportData: { report: { fights: FIGHTS } } }
    })
    const link = await new WclFightFinder({ query: query as never }).find(TARGET)

    expect(link).toMatchObject({
      reportCode: 'abc123',
      reportTitle: 'Heroic night',
      fightId: 8,
      url: 'https://www.warcraftlogs.com/reports/abc123#fight=8'
    })
    expect(link!.parses).toHaveLength(3)
    // The old report is skipped without fetching its fights
    expect(query.mock.calls.filter(([q]) => q.includes('fights {'))).toHaveLength(1)
  })

  it('returns null when the character has no matching report', async () => {
    const query = vi.fn(async () => ({ characterData: { character: null } }))
    expect(await new WclFightFinder({ query: query as never }).find(TARGET)).toBeNull()
  })
})
