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
