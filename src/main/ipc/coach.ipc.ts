// IPC handlers for comparing keys with top Warcraft Logs players.
//
// Commands (ipcMain.handle):
//   coach:getWclStatus     — whether API credentials are saved, and the client ID
//   coach:setWclCredentials — checks a client ID + secret with WCL, then saves them
//   coach:clearWclCredentials
//   coach:getBenchmark     — top runs for a spec, dungeon and key level (cached)

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { WclClient, WclError, type WclCredentials } from '../coach/WclClient'
import { BenchmarkService } from '../coach/BenchmarkService'
import { loadWclCredentials, saveWclCredentials, clearWclCredentials } from '../coach/wclCredentials'
import { WOW_SPEC_ID_MAP } from '@shared/constants'
import type { BenchmarkResult } from '@shared/benchmark.types'

export function registerCoachIpc(): void {
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
}
