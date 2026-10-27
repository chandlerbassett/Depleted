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
    if (!safeStorage.isEncryptionAvailable()) return null
    const parsed = JSON.parse(safeStorage.decryptString(raw)) as Partial<WclCredentials>
    if (typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') return null
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
  } catch {
    return null
  }
}

export async function saveWclCredentials(credentials: WclCredentials): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this Mac')
  await fs.writeFile(credentialsPath(), safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 })
}

export async function clearWclCredentials(): Promise<void> {
  await fs.rm(credentialsPath(), { force: true })
}
