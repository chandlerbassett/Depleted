// Combat log character names ("Name-Realm" or "Name-Realm-US"), for links and lookups on
// Raider.IO, Warcraft Logs and the Armory.

import type { WowRegion } from './ipc.types'

const REGION_CODES = new Set(['EU', 'US', 'KR', 'TW', 'CN', 'OCE'])

interface ParsedCharacter {
  name: string
  realm: string
  region: string
}

// Combat log names omit the region suffix when the character is in the same region
// as the account — falls back to the configured default region in that case.
export function parseCharacterFullName(fullName: string, defaultRegion: WowRegion): ParsedCharacter {
  const parts = fullName.split('-')
  const last = parts[parts.length - 1] ?? ''
  if (REGION_CODES.has(last.toUpperCase()) && parts.length >= 3) {
    return {
      name: parts.slice(0, -2).join('-'),
      realm: parts[parts.length - 2] ?? '',
      region: last.toUpperCase()
    }
  }
  return {
    name: parts.slice(0, -1).join('-'),
    realm: last,
    region: defaultRegion.toUpperCase()
  }
}

// Combat log realm names drop spaces but keep capitals and apostrophes ("MoonGuard",
// "Area52", "Mal'Ganis"). Site slugs put a hyphen at each word break and drop
// apostrophes: moon-guard, area-52, malganis.
export function realmSlug(realm: string): string {
  return realm
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .replace(/'/g, '')
    .toLowerCase()
}
