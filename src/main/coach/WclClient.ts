// Minimal Warcraft Logs v2 API client: client-credentials OAuth and GraphQL queries.
// Each user makes their own API client at warcraftlogs.com/api/clients and enters its
// ID and secret in Settings; the token is kept in memory only.

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token'
const API_URL = 'https://www.warcraftlogs.com/api/v2/client'
// Renew a little before WCL says the token expires
const EXPIRY_MARGIN_MS = 60_000

export interface WclCredentials {
  clientId: string
  clientSecret: string
}

export class WclError extends Error {
  constructor(
    message: string,
    // 'auth' = the client ID or secret was refused
    readonly kind: 'auth' | 'rate-limit' | 'other' = 'other'
  ) {
    super(message)
  }
}

type Fetch = typeof fetch

export class WclClient {
  private token: { value: string; expiresAt: number } | null = null

  constructor(
    private readonly credentials: WclCredentials,
    private readonly fetchFn: Fetch = fetch
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this.accessToken()
    const res = await this.fetchFn(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables })
    })
    if (res.status === 401) {
      this.token = null
      throw new WclError('Warcraft Logs refused the API token', 'auth')
    }
    if (res.status === 429) throw new WclError('Warcraft Logs rate limit reached; try again in a while', 'rate-limit')
    if (!res.ok) throw new WclError(`Warcraft Logs returned HTTP ${res.status}`)
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new WclError(`Warcraft Logs: ${body.errors.map((e) => e.message).join('; ')}`)
    }
    if (body.data === undefined) throw new WclError('Warcraft Logs returned no data')
    return body.data
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && Date.now() < this.token.expiresAt) return this.token.value
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64')
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: 'grant_type=client_credentials'
    })
    if (res.status === 400 || res.status === 401) {
      throw new WclError('Warcraft Logs refused the client ID or secret', 'auth')
    }
    if (!res.ok) throw new WclError(`Warcraft Logs sign-in returned HTTP ${res.status}`)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new WclError('Warcraft Logs sign-in returned no token', 'auth')
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS
    }
    return this.token.value
  }
}
