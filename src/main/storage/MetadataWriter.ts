// Reads and writes metadata.json in a recording directory.
// The JSON file is the single source of truth for all recording metadata.

import { promises as fs } from 'fs'
import { join } from 'path'
import type { RecordingMetadata } from '@shared/ipc.types'
import type { CoachData } from '@shared/coach.types'

export const METADATA_FILENAME = 'metadata.json'
// Coach data lives in its own file: it's large, and the recording list loads every
// metadata.json up front
export const COACH_FILENAME = 'coach.json'

// Writes metadata.json into the given directory, overwriting any existing file.
export async function writeMetadata(dirPath: string, metadata: RecordingMetadata): Promise<void> {
  const filePath = join(dirPath, METADATA_FILENAME)
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 })
}

// Reads and parses metadata.json from the given directory.
// Returns null if the file does not exist or cannot be parsed.
export async function readMetadata(dirPath: string): Promise<RecordingMetadata | null> {
  const filePath = join(dirPath, METADATA_FILENAME)
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return isUsableMetadata(parsed) ? parsed : null
  } catch {
    return null
  }
}

const VIDEO_EXTS = ['mp4', 'webm']

// The fields the app builds paths from or sorts and computes with. A recording folder
// can come from somewhere else (a shared or synced folder), so metadata.json is checked
// before any of it is used; a folder that fails is left out of the library.
export function isUsableMetadata(value: unknown): value is RecordingMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const m = value as Record<string, unknown>
  if (typeof m.date !== 'string' || Number.isNaN(Date.parse(m.date))) return false
  if (typeof m.zone !== 'string') return false
  if (typeof m.duration !== 'number' || !Number.isFinite(m.duration) || m.duration < 0) return false
  if (m.videoExt !== undefined && !VIDEO_EXTS.includes(m.videoExt as string)) return false
  if (!Array.isArray(m.events)) return false
  return true
}

export async function writeCoachData(dirPath: string, coach: CoachData): Promise<void> {
  await fs.writeFile(join(dirPath, COACH_FILENAME), JSON.stringify(coach), { encoding: 'utf8', mode: 0o600 })
}

// Returns null for recordings made before the coach existed
export async function readCoachData(dirPath: string): Promise<CoachData | null> {
  try {
    const text = await fs.readFile(join(dirPath, COACH_FILENAME), 'utf8')
    return JSON.parse(text) as CoachData
  } catch {
    return null
  }
}
