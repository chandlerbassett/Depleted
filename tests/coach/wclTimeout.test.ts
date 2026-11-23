import { describe, it, expect } from 'vitest'
import { WclClient, WclError } from '../../src/main/coach/WclClient'

describe('WclClient', () => {
  it('sends every request with a timeout', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal)
      const body = String(url).includes('oauth') ? { access_token: 't', expires_in: 3600 } : { data: { ok: true } }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    await new WclClient({ clientId: 'id', clientSecret: 'secret' }, fetchFn).query('{ ok }')
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true)
  })

  it('turns a timeout into a WclError', async () => {
    const fetchFn = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as typeof fetch
    const err = await new WclClient({ clientId: 'id', clientSecret: 'secret' }, fetchFn).query('{ ok }').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WclError)
    expect((err as Error).message).toContain('did not answer in time')
  })
})
