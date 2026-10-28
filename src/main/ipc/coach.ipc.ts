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
import { summarizeKey, isCharacter, type KeySummary } from '@shared/coachRecap'
import type { StorageManager } from '../storage/StorageManager'

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

  // Players in each recording's coach data, so listing characters doesn't reread every
  // coach.json. Recordings never change once written.
  const rosters = new Map<string, string[]>()
  // Summaries by recording, player and the benchmark they were compared with
  const summaries = new Map<string, KeySummary>()

  ipcMain.handle('coach:listCharacters', async () => {
    const counts = new Map<string, number>()
    for (const rec of await storageManager.getRecordings()) {
      let names = rosters.get(rec.id)
      if (names === undefined) {
        const data = await storageManager.getCoachData(rec.id)
        names = data?.players.map((p) => p.name) ?? []
        rosters.set(rec.id, names)
      }
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
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
        if (rosters.has(rec.id) && !rosters.get(rec.id)!.some((n) => isCharacter(n, params.playerName))) continue
        const data = await storageManager.getCoachData(rec.id)
        rosters.set(rec.id, data?.players.map((p) => p.name) ?? [])
        const player = data?.players.find((p) => isCharacter(p.name, params.playerName))
        if (data == null || player === undefined) continue

        const dungeon = rec.metadata.zone
        const keyLevel = rec.metadata.mythicPlus.keystoneLevel
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

        const key = `${rec.id}|${player.guid}|${bench?.fetchedAt ?? '-'}`
        let summary = summaries.get(key)
        if (summary === undefined) {
          const review = reviewPlayer(data, player.guid)
          if (review === null) continue
          const comparison = bench !== null ? compareWithTop(data, player.guid, bench) : null
          summary = summarizeKey(
            { recordingId: rec.id, date: rec.metadata.date, dungeon, keyLevel },
            review,
            comparison
          )
          summaries.set(key, summary)
        }
        out.push(summary)
      }
      return { summaries: out, wclConfigured: svc !== null }
    }
  )
}
