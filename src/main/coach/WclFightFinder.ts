// Finds a recording's fight in a Warcraft Logs report. Depleted can't upload logs, so
// this looks through the recent reports of the people in the recording (whoever
// uploaded, live or afterwards) for a fight that started when the recording's did.
// Reports that are private or unlisted to the API client aren't visible.

import type { WclParse, WclFightLink } from '@shared/wclFight.types'
import type { WclQuery } from './BenchmarkService'

const REPORT_URL = 'https://www.warcraftlogs.com/reports'
const RECENT_REPORTS = 10
// Combat log and WCL times come from the same log lines, so they agree to the second;
// this leaves room for a recording that only picked the pull up late
const MAX_START_GAP_MS = 120_000

export interface FightToFind {
  // When the pull or key started (absolute)
  startedAt: Date
  // Raid boss; null for a Mythic+ key (matched as the keystone run instead)
  encounterId: number | null
  // Name-Realm(-Region) of the people in the recording, the one recording first
  characters: Array<{ name: string; serverSlug: string; region: string }>
}

interface ReportSummary {
  code: string
  title: string
  startTime: number
  endTime: number
}

export interface ReportFight {
  id: number
  encounterID: number
  startTime: number
  endTime: number
  keystoneLevel: number | null
}

export class WclFightFinder {
  constructor(private readonly wcl: WclQuery) {}

  async find(target: FightToFind): Promise<WclFightLink | null> {
    const at = target.startedAt.getTime()
    const seen = new Set<string>()
    for (const ch of target.characters) {
      for (const report of await this.recentReports(ch)) {
        if (seen.has(report.code)) continue
        seen.add(report.code)
        if (at < report.startTime - MAX_START_GAP_MS || at > report.endTime + MAX_START_GAP_MS) continue
        const fight = matchFight(await this.fights(report.code), report.startTime, target)
        if (fight !== null) {
          return {
            reportCode: report.code,
            reportTitle: report.title,
            fightId: fight.id,
            url: `${REPORT_URL}/${report.code}#fight=${fight.id}`,
            parses: await this.parses(report.code, fight.id),
            fetchedAt: new Date().toISOString()
          }
        }
      }
    }
    return null
  }

  private async recentReports(ch: FightToFind['characters'][number]): Promise<ReportSummary[]> {
    const data = await this.wcl.query<{
      characterData: { character: { recentReports: { data: ReportSummary[] } | null } | null }
    }>(
      `query ($name: String!, $server: String!, $region: String!) {
        characterData { character(name: $name, serverSlug: $server, serverRegion: $region) {
          recentReports(limit: ${RECENT_REPORTS}) { data { code title startTime endTime } }
        } }
      }`,
      { name: ch.name, server: ch.serverSlug, region: ch.region }
    )
    return data.characterData.character?.recentReports?.data ?? []
  }

  private async fights(code: string): Promise<ReportFight[]> {
    const data = await this.wcl.query<{ reportData: { report: { fights: ReportFight[] } | null } }>(
      `query ($code: String!) {
        reportData { report(code: $code) { fights { id encounterID startTime endTime keystoneLevel } } }
      }`,
      { code }
    )
    return data.reportData.report?.fights ?? []
  }

  private async parses(code: string, fightId: number): Promise<WclParse[]> {
    const data = await this.wcl.query<{ reportData: { report: { rankings: unknown } | null } }>(
      `query ($code: String!, $fight: Int!) {
        reportData { report(code: $code) { rankings(fightIDs: [$fight]) } }
      }`,
      { code, fight: fightId }
    )
    return parseRankings(data.reportData.report?.rankings)
  }
}

// Fight times in a report are ms from the report's start
export function matchFight(fights: ReportFight[], reportStart: number, target: FightToFind): ReportFight | null {
  const at = target.startedAt.getTime()
  let best: ReportFight | null = null
  let bestGap = MAX_START_GAP_MS
  for (const f of fights) {
    const isMatch = target.encounterId !== null ? f.encounterID === target.encounterId : (f.keystoneLevel ?? 0) > 0
    if (!isMatch) continue
    const gap = Math.abs(reportStart + f.startTime - at)
    if (gap <= bestGap) {
      best = f
      bestGap = gap
    }
  }
  return best
}

const ROLES: Array<[string, WclParse['role']]> = [
  ['tanks', 'tank'],
  ['healers', 'healer'],
  ['dps', 'dps']
]

// Report.rankings is untyped JSON: { data: [{ roles: { tanks: { characters: [...] }, ... } }] }
export function parseRankings(json: unknown): WclParse[] {
  const fight = (json as { data?: unknown[] } | null)?.data?.[0] as { roles?: Record<string, unknown> } | undefined
  const out: WclParse[] = []
  for (const [key, role] of ROLES) {
    const chars = (fight?.roles?.[key] as { characters?: unknown[] } | undefined)?.characters ?? []
    for (const c of chars as Array<Record<string, unknown>>) {
      if (typeof c.name !== 'string') continue
      out.push({
        name: c.name,
        spec: typeof c.spec === 'string' ? c.spec : '',
        role,
        amount: typeof c.amount === 'number' ? c.amount : 0,
        percent: typeof c.rankPercent === 'number' ? c.rankPercent : null
      })
    }
  }
  return out
}
