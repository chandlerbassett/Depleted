// Builds "view player" links (Raider.IO, Warcraft Logs, Armory) from a combat-log
// character fullName ("Name-Realm" or "Name-Realm-US"). No new data — reuses names
// already captured in RecordingMetadata.

import type { StatsSite, WowRegion } from '@shared/ipc.types'
import { parseCharacterFullName, realmSlug } from '@shared/characterNames'

export { parseCharacterFullName, realmSlug }

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

export function buildCharacterStatsUrl(site: StatsSite, fullName: string, defaultRegion: WowRegion): string {
  const { name, realm, region } = parseCharacterFullName(fullName, defaultRegion)
  // Names come from the combat log: each one is one path segment, whatever is in it
  const r = encodeURIComponent(region.toLowerCase())
  const slug = encodeURIComponent(realmSlug(realm))
  switch (normalizeStatsSite(site)) {
    case 'warcraftlogs':
      return `https://www.warcraftlogs.com/character/${r}/${slug}/${encodeURIComponent(name.toLowerCase())}`
    case 'armory':
      return `https://worldofwarcraft.blizzard.com/en-us/character/${r}/${slug}/${encodeURIComponent(name.toLowerCase())}`
    case 'raiderio':
    default:
      return `https://raider.io/characters/${r}/${slug}/${encodeURIComponent(name)}`
  }
}
