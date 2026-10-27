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
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf8')
}

// Reads and parses metadata.json from the given directory.
// Returns null if the file does not exist or cannot be parsed.
export async function readMetadata(dirPath: string): Promise<RecordingMetadata | null> {
  const filePath = join(dirPath, METADATA_FILENAME)
  try {
    const text = await fs.readFile(filePath, 'utf8')
    return JSON.parse(text) as RecordingMetadata
  } catch {
    return null
  }
}

export async function writeCoachData(dirPath: string, coach: CoachData): Promise<void> {
  await fs.writeFile(join(dirPath, COACH_FILENAME), JSON.stringify(coach), 'utf8')
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
