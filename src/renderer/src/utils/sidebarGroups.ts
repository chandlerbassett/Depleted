import type { Clip, RaidDifficulty, Recording } from '@shared/ipc.types'

// Pulls further apart than this are different raid nights, so a night past midnight
// stays one night
export const RAID_NIGHT_GAP_MS = 4 * 60 * 60 * 1000

export interface BossGroup {
  encounterId: number
  name: string
  // Oldest first, as they were pulled
  pulls: Recording[]
  killed: boolean
}

export interface RaidNight {
  // The first pull's id
  id: string
  zone: string
  startedAt: string
  difficulties: RaidDifficulty[]
  bosses: BossGroup[]
  pullCount: number
  killCount: number
}

// Newest night first; bosses in the order they were first pulled
export function groupRaidNights(recordings: Recording[]): RaidNight[] {
  const pulls = recordings
    .filter((r) => r.metadata.raid !== undefined)
    .sort((a, b) => a.metadata.date.localeCompare(b.metadata.date))
  const nights: Recording[][] = []
  for (const pull of pulls) {
    const night = nights[nights.length - 1]
    const last = night?.[night.length - 1]
    const sameNight =
      last !== undefined &&
      last.metadata.raid!.instanceId === pull.metadata.raid!.instanceId &&
      Date.parse(pull.metadata.date) - Date.parse(last.metadata.date) <= RAID_NIGHT_GAP_MS
    if (sameNight) night!.push(pull)
    else nights.push([pull])
  }
  return nights.map(toNight).reverse()
}

function toNight(pulls: Recording[]): RaidNight {
  const bosses = new Map<number, BossGroup>()
  const difficulties: RaidDifficulty[] = []
  for (const pull of pulls) {
    const raid = pull.metadata.raid!
    if (!difficulties.includes(raid.difficulty)) difficulties.push(raid.difficulty)
    const boss = bosses.get(raid.encounterId) ?? { encounterId: raid.encounterId, name: raid.encounterName, pulls: [], killed: false }
    boss.pulls.push(pull)
    boss.killed ||= raid.outcome === 'kill'
    bosses.set(raid.encounterId, boss)
  }
  return {
    id: pulls[0]!.id,
    zone: pulls[0]!.metadata.zone,
    startedAt: pulls[0]!.metadata.date,
    difficulties,
    bosses: [...bosses.values()],
    pullCount: pulls.length,
    killCount: pulls.filter((p) => p.metadata.raid!.outcome === 'kill').length
  }
}

export interface ClipEntry {
  clip: Clip
  recording: Recording
}

// Newest first
export function allClips(recordings: Recording[]): ClipEntry[] {
  return recordings
    .flatMap((recording) => recording.clips.map((clip) => ({ clip, recording })))
    .sort((a, b) => b.clip.createdAt.localeCompare(a.clip.createdAt))
}
