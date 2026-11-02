import type { RecordingMetadata } from '@shared/ipc.types'

const KEY_OUTCOME_LABEL = { completed: 'Completed', depleted: 'Depleted', abandoned: 'Abandoned' } as const

// "+15"; null for a key recovered with no level
export function levelBadge(meta: RecordingMetadata): string | null {
  const level = meta.mythicPlus.keystoneLevel
  return level > 0 ? `+${level}` : null
}

export function outcomeLabel(meta: RecordingMetadata): string {
  return KEY_OUTCOME_LABEL[meta.mythicPlus.outcome]
}

// 754 → "12:34"
export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// "Ara-Kara, City of Echoes +12"
export function clipSourceLabel(meta: RecordingMetadata): string {
  const badge = levelBadge(meta)
  return badge !== null ? `${meta.zone} ${badge}` : meta.zone
}
