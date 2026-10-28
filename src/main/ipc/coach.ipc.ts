// IPC handlers for comparing keys with top Warcraft Logs players.
//
// Commands (ipcMain.handle):
//   coach:getWclStatus     — whether API credentials are saved, and the client ID
//   coach:setWclCredentials — checks a client ID + secret with WCL, then saves them
//   coach:clearWclCredentials
//   coach:getBenchmark     — top runs for a spec, dungeon and key level (cached)
//   coach:listCharacters   — characters with coach data, for trends
//   coach:getKeySummaries  — one character's keys boiled down for recap and trends

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { WclClient, WclError, type WclCredentials } from '../coach/WclClient'
import { BenchmarkService } from '../coach/BenchmarkService'
import { loadWclCredentials, saveWclCredentials, clearWclCredentials } from '../coach/wclCredentials'
import { WOW_SPEC_ID_MAP } from '@shared/constants'
import type { Benchmark, BenchmarkResult } from '@shared/benchmark.types'
import { reviewPlayer } from '@shared/coachAnalysis'
import { compareWithTop } from '@shared/coachBenchmark'
import { summarizeBosses, summarizeKey, isCharacter, type KeySummary } from '@shared/coachRecap'
import type { StorageManager } from '../storage/StorageManager'
import type { Recording } from '@shared/ipc.types'

// Bump when KeySummary or how it's worked out changes, so saved summaries are redone
const SUMMARY_CACHE_VERSION = 2

interface SummaryCache {
  version: number
  // By "<player name>|<benchmark fetchedAt or ->"
  entries: Record<string, KeySummary>
}

export function registerCoachIpc(storageManager: StorageManager): void {
  let service: BenchmarkService | null = null
  let serviceFor: string | null = null

  async function benchmarkService(): Promise<BenchmarkService | null> {
    const creds = await loadWclCredentials()
    if (creds === null) return null
    const key = `${creds.clientId}:${creds.clientSecret}`
    if (service === null || serviceFor !== key) {
      service = new BenchmarkService(new WclClient(creds), join(app.getPath('userData'), 'coach-benchmarks'))
      serviceFor = key
    }
    return service
  }

  ipcMain.handle('coach:getWclStatus', async () => {
    const creds = await loadWclCredentials()
    return { configured: creds !== null, clientId: creds?.clientId ?? null }
  })

  ipcMain.handle('coach:setWclCredentials', async (_event, params: WclCredentials) => {
    const creds = { clientId: params.clientId.trim(), clientSecret: params.clientSecret.trim() }
    if (!creds.clientId || !creds.clientSecret) return { ok: false, error: 'Enter both the client ID and the secret' }
    try {
      await new WclClient(creds).query('{ rateLimitData { limitPerHour } }')
      await saveWclCredentials(creds)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('coach:clearWclCredentials', async () => {
    await clearWclCredentials()
    service = null
    serviceFor = null
  })

  ipcMain.handle(
    'coach:getBenchmark',
    async (_event, params: { specId: number; dungeon: string; keyLevel: number }): Promise<BenchmarkResult> => {
      if (WOW_SPEC_ID_MAP[params.specId] === undefined) {
        return { status: 'unsupported', message: 'This player’s spec wasn’t in the combat log' }
      }
      if (!params.dungeon || !(params.keyLevel >= 2)) {
        return { status: 'unsupported', message: 'This recording has no dungeon or key level' }
      }
      const svc = await benchmarkService()
      if (svc === null) return { status: 'no-credentials' }
      try {
        return { status: 'ok', benchmark: await svc.get(params.specId, params.dungeon, params.keyLevel) }
      } catch (err) {
        if (err instanceof WclError && err.kind === 'auth') return { status: 'no-credentials' }
        console.warn('[Coach] Benchmark failed:', err instanceof Error ? err.message : String(err))
        return { status: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Players in each recording, so listing characters doesn't reread every coach.json.
  // Recordings never change once written.
  const rosters = new Map<string, string[]>()
  // Summaries by recording, player and the benchmark they were compared with. Also
  // saved in each recording's folder (SummaryCache), so an app start doesn't redo them.
  const summaries = new Map<string, KeySummary>()

  async function rosterOf(rec: Recording): Promise<string[]> {
    let names = rosters.get(rec.id)
    if (names === undefined) {
      const party = rec.metadata.teamComp.filter((n) => n !== '')
      names = party.length > 0 ? party : ((await storageManager.getCoachData(rec.id))?.players.map((p) => p.name) ?? [])
      rosters.set(rec.id, names)
    }
    return names
  }

  async function cachedSummary(rec: Recording, entry: string): Promise<KeySummary | undefined> {
    const key = `${rec.id}|${entry}`
    const inMemory = summaries.get(key)
    if (inMemory !== undefined) return inMemory
    const cache = (await storageManager.readSummaryCache(rec.id)) as SummaryCache | null
    if (cache?.version !== SUMMARY_CACHE_VERSION) return undefined
    for (const [k, summary] of Object.entries(cache.entries)) summaries.set(`${rec.id}|${k}`, summary)
    return summaries.get(key)
  }

  async function saveSummary(rec: Recording, entry: string, summary: KeySummary): Promise<void> {
    summaries.set(`${rec.id}|${entry}`, summary)
    const prefix = `${rec.id}|`
    const entries: Record<string, KeySummary> = {}
    for (const [k, s] of summaries) if (k.startsWith(prefix)) entries[k.slice(prefix.length)] = s
    const cache: SummaryCache = { version: SUMMARY_CACHE_VERSION, entries }
    await storageManager.writeSummaryCache(rec.id, cache).catch((err: unknown) => {
      console.warn('[Coach] Could not save key summaries:', err instanceof Error ? err.message : String(err))
    })
  }

  ipcMain.handle('coach:listCharacters', async () => {
    const counts = new Map<string, number>()
    for (const rec of await storageManager.getRecordings()) {
      for (const n of await rosterOf(rec)) counts.set(n, (counts.get(n) ?? 0) + 1)
    }
    return [...counts]
      .map(([name, keys]) => ({ name, keys }))
      .sort((a, b) => b.keys - a.keys || a.name.localeCompare(b.name))
  })

  ipcMain.handle(
    'coach:getKeySummaries',
    async (_event, params: { playerName: string; fetchMissing: boolean }) => {
      const svc = await benchmarkService()
      const out: KeySummary[] = []
      // Benchmarks already looked at in this call, by spec, dungeon and level
      const benches = new Map<string, Benchmark | null>()
      for (const rec of await storageManager.getRecordings()) {
        if (!(await rosterOf(rec)).some((n) => isCharacter(n, params.playerName))) continue
        const dungeon = rec.metadata.zone
        const keyLevel = rec.metadata.mythicPlus.keystoneLevel
        // Already summarized with no top-player comparison to add: no need to read coach.json
        const plain = await cachedSummary(rec, `${params.playerName}|-`)
        if (plain !== undefined && (svc === null || plain.specId === null || !dungeon || keyLevel < 2)) {
          out.push(plain)
          continue
        }

        const data = await storageManager.getCoachData(rec.id)
        const player = data?.players.find((p) => isCharacter(p.name, params.playerName))
        if (data == null || player === undefined) continue

        let bench: Benchmark | null = null
        if (svc !== null && player.specId !== null && dungeon && keyLevel >= 2) {
          const bk = `${player.specId}:${dungeon}:${keyLevel}`
          if (benches.has(bk)) bench = benches.get(bk)!
          else {
            try {
              bench = params.fetchMissing
                ? await svc.get(player.specId, dungeon, keyLevel)
                : await svc.peek(player.specId, dungeon, keyLevel)
            } catch (err) {
              console.warn('[Coach] Benchmark for trends failed:', err instanceof Error ? err.message : String(err))
            }
            benches.set(bk, bench)
          }
        }

        const entry = `${params.playerName}|${bench?.fetchedAt ?? '-'}`
        let summary = await cachedSummary(rec, entry)
        if (summary === undefined) {
          const review = reviewPlayer(data, player.guid)
          if (review === null) continue
          const comparison = bench !== null ? compareWithTop(data, player.guid, bench) : null
          const encounters = rec.metadata.mythicPlus.encounters ?? []
          summary = summarizeKey(
            { recordingId: rec.id, date: rec.metadata.date, dungeon, keyLevel },
            review,
            comparison,
            summarizeBosses(data, review, encounters)
          )
          await saveSummary(rec, entry, summary)
        }
        out.push(summary)
      }
      return { summaries: out, wclConfigured: svc !== null }
    }
  )
}
