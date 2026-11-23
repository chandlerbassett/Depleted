// A recording's fight on Warcraft Logs, found from a report someone in the group uploaded.

export interface WclParse {
  name: string
  spec: string
  role: 'tank' | 'healer' | 'dps'
  // DPS, or HPS for healers
  amount: number
  // Parse percentile; null when WCL hasn't ranked the fight (yet)
  percent: number | null
}

export interface WclFightLink {
  reportCode: string
  reportTitle: string
  fightId: number
  url: string
  // Empty for wipes, and for kills WCL hasn't finished ranking
  parses: WclParse[]
  fetchedAt: string
}

export type WclFightResult =
  | { status: 'ok'; link: WclFightLink }
  | { status: 'not-found'; message: string }
  | { status: 'no-credentials' }
  | { status: 'error'; message: string }

// Warcraft Logs report codes are short alphanumeric strings
export const WCL_REPORT_CODE_RE = /^[A-Za-z0-9]{1,32}$/

export function wclFightUrl(reportCode: string, fightId: number): string {
  return `https://www.warcraftlogs.com/reports/${encodeURIComponent(reportCode)}#fight=${fightId}`
}
