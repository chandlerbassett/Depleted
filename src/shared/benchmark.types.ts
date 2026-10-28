// Top players' runs of one spec in one dungeon around one key level, fetched from
// Warcraft Logs by the main process and cached on disk. Times are seconds from the
// key's start (CHALLENGE_MODE_START), like the logs WCL keeps.

export interface BenchmarkRun {
  name: string
  server: string
  region: string
  // DPS, or HPS for healers, over the whole key as WCL ranks it
  amount: number
  keyLevel: number
  durationSecs: number
  reportCode: string
  fightId: number
  // The player's first damage, a stand-in for the first pull
  firstPull: number
  // Successful casts: [secs, spellId]
  casts: Array<[number, number]>
  // Equipped item IDs and talent picks [nodeId, entryId] from WCL's CombatantInfo; empty
  // when the report didn't have it
  gear: number[]
  talents: Array<[number, number]>
}

export interface Benchmark {
  version: 2
  specId: number
  dungeon: string
  encounterId: number
  keyLevel: number
  metric: 'dps' | 'hps'
  fetchedAt: string
  runs: BenchmarkRun[]
  // spellId → name, for spells most runs cast
  spellNames: Record<number, string>
  // itemId → name, for items many runs wear
  itemNames: Record<number, string>
}

export type BenchmarkResult =
  | { status: 'ok'; benchmark: Benchmark }
  | { status: 'no-credentials' }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }
