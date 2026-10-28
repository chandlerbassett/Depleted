// Builds a Benchmark: the top-ranked Warcraft Logs runs for one spec in one dungeon at
// about one key level, with each top player's casts. Cached on disk for a few days so
// opening the Coach panel again costs no API points.
//
// WCL calls per uncached benchmark: the season's dungeon list (once per app run), one
// rankings page per key level tried, two batched report queries, then batched names
// for spells and items.

import { promises as fs } from 'fs'
import { join } from 'path'
import { WOW_SPEC_ID_MAP } from '@shared/constants'
import type { Benchmark, BenchmarkRun } from '@shared/benchmark.types'

// How many top runs to learn from, and the fewest worth using
export const TARGET_RUNS = 15
const MIN_RUNS = 5
// Key levels tried, nearest first, until there are enough runs
const LEVEL_OFFSETS = [0, -1, 1, -2, 2]
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
const EVENTS_PAGE = 10000

export interface WclQuery {
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>
}

interface Ranking {
  name: string
  amount: number
  hardModeLevel: number
  duration: number
  report: { code: string; fightID: number }
  server: { name: string; region: string }
}

// WCL's CombatantInfo event, as far as the Coach reads it
interface CombatantInfo {
  gear?: Array<{ id?: number; name?: string }>
  talentTree?: Array<{ id: number; nodeID?: number; nodeId?: number }>
}

interface ZoneList {
  worldData: {
    expansions: Array<{
      id: number
      zones: Array<{ id: number; name: string; frozen: boolean; encounters: Array<{ id: number; name: string }> }>
    }>
  }
}

export class BenchmarkService {
  private encounters: Map<string, number> | null = null
  private readonly inFlight = new Map<string, Promise<Benchmark>>()
  // Item names that came with CombatantInfo, so they needn't be looked up
  private readonly seenItemNames = new Map<number, string>()

  constructor(
    private readonly wcl: WclQuery,
    private readonly cacheDir: string
  ) {}

  async get(specId: number, dungeon: string, keyLevel: number): Promise<Benchmark> {
    const spec = WOW_SPEC_ID_MAP[specId]
    if (spec === undefined) throw new Error(`Unknown spec ${specId}`)
    const encounterId = await this.encounterFor(dungeon)
    const key = `${specId}-${encounterId}-${keyLevel}`

    const cached = await this.readCache(key)
    if (cached !== null) return cached

    let pending = this.inFlight.get(key)
    if (pending === undefined) {
      pending = this.build(specId, dungeon, encounterId, keyLevel)
        .then(async (bench) => {
          await this.writeCache(key, bench)
          return bench
        })
        .finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, pending)
    }
    return pending
  }

  // ---------------------------------------------------------------------------

  private async build(specId: number, dungeon: string, encounterId: number, keyLevel: number): Promise<Benchmark> {
    const spec = WOW_SPEC_ID_MAP[specId]!
    const metric = spec.isHealer ? 'hps' : 'dps'
    const rankings = await this.topRankings(encounterId, wclName(spec.class), wclName(spec.spec), metric, keyLevel)
    if (rankings.length < MIN_RUNS) {
      throw new Error(`Only ${rankings.length} ranked ${spec.spec} ${spec.class} runs near +${keyLevel} in ${dungeon} on Warcraft Logs`)
    }
    const runs = await this.fetchRuns(rankings, wclName(spec.class))
    return {
      version: 2,
      specId,
      dungeon,
      encounterId,
      keyLevel,
      metric,
      fetchedAt: new Date().toISOString(),
      runs,
      spellNames: await this.spellNames(runs),
      itemNames: await this.itemNames(runs)
    }
  }

  // A cached benchmark, without fetching runs. Still looks up the dungeon list once.
  async peek(specId: number, dungeon: string, keyLevel: number): Promise<Benchmark | null> {
    if (WOW_SPEC_ID_MAP[specId] === undefined) return null
    const encounterId = await this.encounterFor(dungeon)
    return this.readCache(`${specId}-${encounterId}-${keyLevel}`)
  }

  // Dungeon name as the combat log has it → WCL encounter ID, from the newest M+ seasons
  private async encounterFor(dungeon: string): Promise<number> {
    if (this.encounters === null) {
      const data = await this.wcl.query<ZoneList>(
        '{ worldData { expansions { id zones { id name frozen encounters { id name } } } } }'
      )
      const zones = data.worldData.expansions
        .flatMap((e) => e.zones)
        .filter((z) => z.name.startsWith('Mythic+') && !/PTR|Beta/i.test(z.name))
        // Live season first, then newest
        .sort((a, b) => Number(a.frozen) - Number(b.frozen) || b.id - a.id)
      const map = new Map<string, number>()
      for (const zone of zones) {
        for (const enc of zone.encounters) {
          const k = normalize(enc.name)
          if (!map.has(k)) map.set(k, enc.id)
        }
      }
      this.encounters = map
    }
    const id = this.encounters.get(normalize(dungeon))
    if (id === undefined) throw new Error(`Warcraft Logs has no Mythic+ rankings for ${dungeon}`)
    return id
  }

  private async topRankings(
    encounterId: number,
    className: string,
    specName: string,
    metric: 'dps' | 'hps',
    keyLevel: number
  ): Promise<Ranking[]> {
    const pool = new Map<string, Ranking>()
    const near = (r: Ranking): boolean => Math.abs(r.hardModeLevel - keyLevel) <= 2
    for (const offset of LEVEL_OFFSETS) {
      const level = keyLevel + offset
      if (level < 2) continue
      // WCL's keystone bracket N holds +(N+1) keys
      const data = await this.wcl.query<{ worldData: { encounter: { characterRankings: { rankings?: Ranking[] } } | null } }>(
        `query ($id: Int!, $cls: String!, $spec: String!, $bracket: Int!) {
          worldData { encounter(id: $id) {
            characterRankings(className: $cls, specName: $spec, metric: ${metric}, bracket: $bracket)
          } }
        }`,
        { id: encounterId, cls: className, spec: specName, bracket: level - 1 }
      )
      for (const r of data.worldData.encounter?.characterRankings.rankings ?? []) {
        if (near(r) && isReportCode(r.report?.code)) pool.set(`${r.report.code}:${r.report.fightID}`, r)
      }
      const exact = [...pool.values()].filter((r) => r.hardModeLevel === keyLevel).length
      if (exact >= TARGET_RUNS || (offset !== 0 && pool.size >= TARGET_RUNS)) break
    }
    // Same level first, then the nearest, best output first within each
    return [...pool.values()]
      .sort(
        (a, b) =>
          Math.abs(a.hardModeLevel - keyLevel) - Math.abs(b.hardModeLevel - keyLevel) || b.amount - a.amount
      )
      .slice(0, TARGET_RUNS)
  }

  private async fetchRuns(rankings: Ranking[], className: string): Promise<BenchmarkRun[]> {
    // Pass 1: each fight's start and its players, to find the ranked player's actor ID
    const meta = await this.wcl.query<
      Record<
        string,
        {
          report: {
            fights: Array<{ startTime: number; friendlyPlayers: number[] | null }>
            masterData: { actors: Array<{ id: number; name: string; subType: string }> }
          } | null
        }
      >
    >(
      `{ ${rankings
        .map(
          (r, i) => `r${i}: reportData { report(code: "${r.report.code}") {
            fights(fightIDs: [${r.report.fightID}]) { startTime friendlyPlayers }
            masterData { actors(type: "Player") { id name subType } }
          } }`
        )
        .join('\n')} }`
    )

    const located: Array<{ ranking: Ranking; sourceId: number; fightStart: number }> = []
    rankings.forEach((r, i) => {
      const report = meta[`r${i}`]?.report
      const fight = report?.fights[0]
      if (report === undefined || report === null || fight === undefined) return
      const inFight = new Set(fight.friendlyPlayers ?? [])
      const actor =
        report.masterData.actors.find((a) => a.name === r.name && inFight.has(a.id) && a.subType === className) ??
        report.masterData.actors.find((a) => a.name === r.name && inFight.has(a.id))
      if (actor !== undefined) located.push({ ranking: r, sourceId: actor.id, fightStart: fight.startTime })
    })

    // Pass 2: the player's casts, first damage, and gear and talents in each run
    type Events = { data: Array<{ timestamp: number; type: string; abilityGameID: number }>; nextPageTimestamp: number | null }
    const events = await this.wcl.query<
      Record<string, { report: { casts: Events; dmg: Events; info?: { data: CombatantInfo[] } } | null }>
    >(
      `{ ${located
        .map(
          (l, i) => `e${i}: reportData { report(code: "${l.ranking.report.code}") {
            casts: events(fightIDs: [${l.ranking.report.fightID}], sourceID: ${l.sourceId}, dataType: Casts, limit: ${EVENTS_PAGE}) { data nextPageTimestamp }
            dmg: events(fightIDs: [${l.ranking.report.fightID}], sourceID: ${l.sourceId}, dataType: DamageDone, limit: 1) { data nextPageTimestamp }
            info: events(fightIDs: [${l.ranking.report.fightID}], sourceID: ${l.sourceId}, dataType: CombatantInfo, limit: 5) { data }
          } }`
        )
        .join('\n')} }`
    )

    const runs: BenchmarkRun[] = []
    for (let i = 0; i < located.length; i++) {
      const { ranking, sourceId, fightStart } = located[i]!
      const report = events[`e${i}`]?.report
      if (report === undefined || report === null) continue
      const castEvents = [...report.casts.data]
      let next = report.casts.nextPageTimestamp
      while (next !== null) {
        const page = await this.moreCasts(ranking, sourceId, next)
        castEvents.push(...page.data)
        next = page.nextPageTimestamp
      }
      const secs = (ts: number): number => Math.round((ts - fightStart) / 10) / 100
      const casts = castEvents
        .filter((e) => e.type === 'cast')
        .map((e): [number, number] => [secs(e.timestamp), e.abilityGameID])
      if (casts.length === 0) continue
      const firstDamage = report.dmg.data[0]?.timestamp
      const info = report.info?.data.find((e) => Array.isArray(e.gear) || Array.isArray(e.talentTree))
      for (const item of info?.gear ?? []) if (item.id !== undefined && item.id > 0 && item.name) this.seenItemNames.set(item.id, item.name)
      runs.push({
        name: ranking.name,
        server: ranking.server.name,
        region: ranking.server.region,
        amount: ranking.amount,
        keyLevel: ranking.hardModeLevel,
        durationSecs: Math.round(ranking.duration / 1000),
        reportCode: ranking.report.code,
        fightId: ranking.report.fightID,
        firstPull: firstDamage !== undefined ? secs(firstDamage) : casts[0]![0],
        casts,
        gear: (info?.gear ?? []).map((g) => g.id ?? 0),
        talents: (info?.talentTree ?? [])
          .map((t): [number, number] => [t.nodeID ?? t.nodeId ?? 0, t.id])
          .filter(([, entry]) => entry > 0)
      })
    }
    if (runs.length < MIN_RUNS) throw new Error('Could not read enough top runs from Warcraft Logs')
    return runs
  }

  private async moreCasts(
    ranking: Ranking,
    sourceId: number,
    startTime: number
  ): Promise<{ data: Array<{ timestamp: number; type: string; abilityGameID: number }>; nextPageTimestamp: number | null }> {
    const data = await this.wcl.query<{ reportData: { report: { events: { data: never[]; nextPageTimestamp: number | null } } } }>(
      `{ reportData { report(code: "${ranking.report.code}") {
        events(fightIDs: [${ranking.report.fightID}], sourceID: ${sourceId}, dataType: Casts, startTime: ${startTime}, limit: ${EVENTS_PAGE}) { data nextPageTimestamp }
      } } }`
    )
    return data.reportData.report.events
  }

  // Names for spells at least half the runs cast; the player's own spells are named by
  // their combat log already
  private async spellNames(runs: BenchmarkRun[]): Promise<Record<number, string>> {
    const counts = new Map<number, number>()
    for (const run of runs) for (const id of new Set(run.casts.map(([, id]) => id))) counts.set(id, (counts.get(id) ?? 0) + 1)
    const ids = [...counts].filter(([, n]) => n >= runs.length / 2).map(([id]) => id)
    if (ids.length === 0) return {}
    const data = await this.wcl.query<Record<string, { ability: { id: number; name: string } | null }>>(
      `{ ${ids.map((id) => `s${id}: gameData { ability(id: ${id}) { id name } }`).join('\n')} }`
    )
    const names: Record<number, string> = {}
    for (const entry of Object.values(data)) if (entry.ability !== null) names[entry.ability.id] = entry.ability.name
    return names
  }

  // Names for items worn in at least a third of the runs: enough to name the trinket or
  // weapon a spell comes from. WCL usually names gear in CombatantInfo already.
  private async itemNames(runs: BenchmarkRun[]): Promise<Record<number, string>> {
    const counts = new Map<number, number>()
    for (const run of runs) for (const id of new Set(run.gear)) if (id > 0) counts.set(id, (counts.get(id) ?? 0) + 1)
    const ids = [...counts].filter(([, n]) => n >= runs.length / 3).map(([id]) => id)
    const names: Record<number, string> = {}
    const missing: number[] = []
    for (const id of ids) {
      const seen = this.seenItemNames.get(id)
      if (seen !== undefined) names[id] = seen
      else missing.push(id)
    }
    if (missing.length > 0) {
      try {
        const data = await this.wcl.query<Record<string, { item: { id: number; name: string } | null }>>(
          `{ ${missing.map((id) => `i${id}: gameData { item(id: ${id}) { id name } }`).join('\n')} }`
        )
        for (const entry of Object.values(data)) if (entry.item !== null) names[entry.item.id] = entry.item.name
      } catch (err) {
        // Unnamed items still compare; the panel calls them "an item"
        console.warn('[Benchmark] Could not name items:', err instanceof Error ? err.message : String(err))
      }
    }
    return names
  }

  private async readCache(key: string): Promise<Benchmark | null> {
    try {
      const bench = JSON.parse(await fs.readFile(join(this.cacheDir, `${key}.json`), 'utf8')) as Benchmark
      if (bench.version !== 2 || Date.now() - Date.parse(bench.fetchedAt) > CACHE_TTL_MS) return null
      return bench
    } catch {
      return null
    }
  }

  private async writeCache(key: string, bench: Benchmark): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
      await fs.writeFile(join(this.cacheDir, `${key}.json`), JSON.stringify(bench))
    } catch (err) {
      console.warn('[Benchmark] Could not cache:', err instanceof Error ? err.message : String(err))
    }
  }
}

// "Death Knight" → "DeathKnight", "Beast Mastery" → "BeastMastery", as WCL names them
function wclName(name: string): string {
  return name.replace(/\s+/g, '')
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Report codes go into the query text, so only accept what WCL issues
function isReportCode(code: string | undefined): code is string {
  return code !== undefined && /^[A-Za-z0-9]+$/.test(code)
}
