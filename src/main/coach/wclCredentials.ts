// The user's Warcraft Logs API client ID and secret, encrypted with Electron's
// safeStorage (the macOS Keychain) in the app's data folder. Never sent to the renderer:
// it only learns whether they're set and the client ID.

import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { WclCredentials } from './WclClient'

function credentialsPath(): string {
  return join(app.getPath('userData'), 'wcl-credentials.bin')
}

export async function loadWclCredentials(): Promise<WclCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsPath())
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(raw)
    const parsed = JSON.parse(result) as Partial<WclCredentials>
    if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') return null
    const credentials = { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
    // The Keychain key was rotated: store it again under the new one
    if (shouldReEncrypt) await saveWclCredentials(credentials).catch(() => undefined)
    return credentials
  } catch {
    return null
  }
}

export async function saveWclCredentials(credentials: WclCredentials): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Secure storage is not available on this Mac')
  await fs.writeFile(credentialsPath(), await safeStorage.encryptStringAsync(JSON.stringify(credentials)), { mode: 0o600 })
}

export async function clearWclCredentials(): Promise<void> {
  await fs.rm(credentialsPath(), { force: true })
}
