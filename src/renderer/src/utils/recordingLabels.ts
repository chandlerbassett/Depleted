import type { RecordingMetadata } from '@shared/ipc.types'
import { RAID_DIFFICULTY_LABEL } from '@shared/constants'

const KEY_OUTCOME_LABEL = { completed: 'Completed', depleted: 'Depleted', abandoned: 'Abandoned' } as const
const RAID_OUTCOME_LABEL = { kill: 'Kill', wipe: 'Wipe' } as const

// "+15" for a key, "Heroic" for a raid pull; null for a key recovered with no level
export function levelBadge(meta: RecordingMetadata): string | null {
  if (meta.raid !== undefined) return RAID_DIFFICULTY_LABEL[meta.raid.difficulty]
  const level = meta.mythicPlus?.keystoneLevel ?? 0
  return level > 0 ? `+${level}` : null
}

export function outcomeLabel(meta: RecordingMetadata): string {
  if (meta.raid !== undefined) return RAID_OUTCOME_LABEL[meta.raid.outcome]
  return KEY_OUTCOME_LABEL[meta.mythicPlus?.outcome ?? 'abandoned']
}

// The dungeon for a key; the boss and pull number for a raid pull
export function recordingTitle(meta: RecordingMetadata): string {
  if (meta.raid === undefined) return meta.zone
  const pull = meta.raid.pullNumber > 0 ? ` · Pull ${meta.raid.pullNumber}` : ''
  return `${meta.raid.encounterName}${pull}`
}

// 754 → "12:34"
export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// "Plexus Sentinel · Pull 3 (Heroic)", "Ara-Kara, City of Echoes +12"
export function clipSourceLabel(meta: RecordingMetadata): string {
  const badge = levelBadge(meta)
  if (meta.raid !== undefined) return badge !== null ? `${recordingTitle(meta)} (${badge})` : recordingTitle(meta)
  return badge !== null ? `${meta.zone} ${badge}` : meta.zone
}
