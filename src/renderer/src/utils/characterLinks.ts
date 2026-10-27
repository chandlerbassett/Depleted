// Builds "view player" links (Raider.IO, Warcraft Logs, Armory) from a combat-log
// character fullName ("Name-Realm" or "Name-Realm-US"). No new data — reuses names
// already captured in RecordingMetadata.

import type { StatsSite, WowRegion } from '@shared/ipc.types'

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

export const STATS_SITE_LABELS: Readonly<Record<StatsSite, string>> = {
  raiderio: 'Raider.IO',
  warcraftlogs: 'Warcraft Logs',
  armory: 'Armory'
}

export const STATS_SITES: readonly StatsSite[] = ['raiderio', 'warcraftlogs', 'armory']

// Configs saved before the PvP sites were dropped can still hold one of them
export function normalizeStatsSite(site: string | undefined): StatsSite {
  return STATS_SITES.includes(site as StatsSite) ? (site as StatsSite) : 'raiderio'
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

export function buildCharacterStatsUrl(site: StatsSite, fullName: string, defaultRegion: WowRegion): string {
  const { name, realm, region } = parseCharacterFullName(fullName, defaultRegion)
  const r = region.toLowerCase()
  const slug = realmSlug(realm)
  switch (normalizeStatsSite(site)) {
    case 'warcraftlogs':
      return `https://www.warcraftlogs.com/character/${r}/${slug}/${name.toLowerCase()}`
    case 'armory':
      return `https://worldofwarcraft.blizzard.com/en-us/character/${r}/${slug}/${name.toLowerCase()}`
    case 'raiderio':
    default:
      return `https://raider.io/characters/${r}/${slug}/${encodeURIComponent(name)}`
  }
}
