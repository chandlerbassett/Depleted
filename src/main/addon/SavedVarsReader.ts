// Reads the DepletedCompanion SavedVariables file and extracts player info.
//
// File location:
//   {wowPath}/_retail_/WTF/Account/*/SavedVariables/DepletedCompanion.lua
//
// The account directory name is not predictable (it's a Battle.net account ID),
// so we glob for all accounts and return the most recently modified match.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { ADDON_NAME, ADDON_STALE_MS, MIN_ADDON_VERSION } from '@shared/constants'

export interface AddonCharacterInfo {
  guid: string       // e.g. "Player-1329-0A8F36D7"
  name: string
  realm: string
  fullName: string   // "Name-Realm"
  class: string
  spec: string
  // ISO timestamp written on PLAYER_LOGIN/PLAYER_ENTERING_WORLD/spec change — how
  // recent this is is used to distinguish "addon connected" from a stale on-disk
  // snapshot from a session that ended days ago (see ADDON_STALE_MS).
  updated: string | null
  // Addon's own DepletedCompanion.lua version, if the installed copy is new
  // enough to write it (added in 1.2.0) — null for older installs.
  version: string | null
}

// {wowPath}/_retail_/WTF/Account/*/SavedVariables/DepletedCompanion.lua that exist
function savedVarsFiles(wowPath: string): string[] {
  const accountsDir = join(wowPath, '_retail_', 'WTF', 'Account')
  let accounts: string[]
  try {
    accounts = readdirSync(accountsDir)
  } catch {
    return []
  }
  return accounts
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(accountsDir, name, 'SavedVariables', `${ADDON_NAME}.lua`))
    .filter((file) => existsSync(file))
}

export function readAddonCharacterInfo(wowPath: string): AddonCharacterInfo | null {
  const files = savedVarsFiles(wowPath)
  if (files.length === 0) return null

  // Pick the most recently modified file if there are multiple accounts
  const file = files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })[0]!

  let content: string
  try {
    content = readFileSync(file, 'utf-8')
  } catch {
    return null
  }

  return parseSavedVars(content)
}

// Parses the Lua SavedVariables table with simple string extraction.
// Handles the format written by WoW's SavedVariables serialiser:
//   DepletedDB = {
//     ["character"] = {
//       ["guid"] = "Player-1329-XXXXXXXX",
//       ...
//     },
//   }
function parseSavedVars(content: string): AddonCharacterInfo | null {
  const extract = (key: string): string => {
    const re = new RegExp(`\\["${key}"\\]\\s*=\\s*"([^"]*)"`)
    return re.exec(content)?.[1] ?? ''
  }
  const extractOptional = (key: string): string | null => {
    const value = extract(key)
    return value.length > 0 ? value : null
  }

  const guid = extract('guid')
  if (!guid.startsWith('Player-')) return null

  return {
    guid,
    name: extract('name'),
    realm: extract('realm'),
    fullName: extract('fullName'),
    class: extract('class'),
    spec: extract('spec'),
    updated: extractOptional('updated'),
    version: extractOptional('version'),
  }
}

// "connected" means the addon is not just installed, but was actually alive recently —
// its `updated` timestamp (refreshed on login/zone-change/spec-change) is within
// ADDON_STALE_MS. Older SavedVariables (e.g. from a session that ended days ago and was
// never reloaded since) reports connected: false rather than showing stale class/spec
// info indefinitely.
export function isAddonInfoStale(info: AddonCharacterInfo): boolean {
  if (info.updated === null) return true
  const updatedMs = Date.parse(info.updated)
  if (Number.isNaN(updatedMs)) return true
  return Date.now() - updatedMs > ADDON_STALE_MS
}

// True when the installed addon predates MIN_ADDON_VERSION (or never reported a version
// at all — installs before 1.2.0 didn't write one), meaning it's missing something the
// app now relies on and the user should be prompted to update it.
export function isAddonVersionOutdated(info: AddonCharacterInfo): boolean {
  if (info.version === null) return true
  return compareVersions(info.version, MIN_ADDON_VERSION) < 0
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
