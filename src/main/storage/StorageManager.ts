// Manages the recording library and post-processing pipeline.
//
// Post-processing flow (triggered by MythicPlusStateMachine.processingRequired):
//   1. Build output directory name and create it
//   2. Trim raw video to exact key duration (no re-encode; see MediaTools)
//   3. Generate thumbnail from the trimmed video
//   4. Write metadata.json
//   5. Delete the raw (untrimmed) file
//
// The trim offset is the wall-clock difference between when recording started and
// where the kept footage begins (event.matchStartedAt).
//
// Library operations:
//   getRecordings()          — scan storage directory, return all Recording[]
//   deleteRecording(id)      — remove a recording directory
//   getCoachData(id)         — a recording's coach.json, null for older recordings
//   findOrphanedRecordings() — directories that have a recording video but no metadata.json

import { promises as fs } from 'fs'
import { join, extname } from 'path'
import { spawn } from 'child_process'
import type { Recording, RecordingMetadata, TimelineEvent } from '@shared/ipc.types'
import type { ProcessingRequiredEvent } from '../recorder/types'
import { runHelperCommand } from '../recorder/nativeHelper'
import { writeMetadata, readMetadata, writeCoachData, readCoachData } from './MetadataWriter'
import type { CoachData } from '@shared/coach.types'

// ---------------------------------------------------------------------------
// Media tools — trim + thumbnail. The depleted-capture helper (AVFoundation) on macOS,
// FFmpeg elsewhere.
// ---------------------------------------------------------------------------

export interface MediaTools {
  trim(inputPath: string, outputPath: string, offsetSecs: number, durationSecs: number): Promise<void>
  thumbnail(videoPath: string, thumbnailPath: string): Promise<void>
}

export function nativeMediaTools(helperPath: string): MediaTools {
  return {
    trim: async (inputPath, outputPath, offsetSecs, durationSecs) => {
      await runHelperCommand(helperPath, [
        'trim',
        '--input',
        inputPath,
        '--output',
        outputPath,
        '--start',
        offsetSecs.toFixed(3),
        '--duration',
        String(durationSecs)
      ])
    },
    thumbnail: async (videoPath, thumbnailPath) => {
      await runHelperCommand(helperPath, ['thumbnail', '--input', videoPath, '--output', thumbnailPath, '--at', '5'])
    }
  }
}

export function ffmpegMediaTools(ffmpegPath: string, runner: FfmpegRunner = defaultFfmpegRunner): MediaTools {
  return {
    trim: (inputPath, outputPath, offsetSecs, durationSecs) =>
      trimVideo(runner, ffmpegPath, inputPath, outputPath, offsetSecs, durationSecs),
    thumbnail: (videoPath, thumbnailPath) => generateThumbnail(runner, ffmpegPath, videoPath, thumbnailPath)
  }
}

export type FfmpegRunner = (ffmpegPath: string, args: string[]) => Promise<void>

// Default runner: spawns FFmpeg as a child process.
export const defaultFfmpegRunner: FfmpegRunner = (
  ffmpegPath: string,
  args: string[]
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const stderrLines: string[] = []
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrLines.push(chunk.toString())
    })

    proc.on('error', (err: Error) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`))
    })

    proc.on('close', (code: number | null) => {
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${code}.\n${stderrLines.slice(-10).join('\n')}`))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// StorageManager
// ---------------------------------------------------------------------------

export class StorageManager {
  private readonly storagePath: string
  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  // -------------------------------------------------------------------------
  // Post-processing
  // -------------------------------------------------------------------------

  // Trims, thumbnails, and stores a completed key recording.
  async processRecording(
    event: ProcessingRequiredEvent,
    media: MediaTools,
    timeline: TimelineEvent[] = []
  ): Promise<Recording> {
    const dirName = buildDirName(event)
    const dirPath = join(this.storagePath, dirName)
    // The raw file's extension is the container the recorder produced (always mp4 from
    // the native helper; mp4 or webm from MediaRecorder) — mirror it for the trimmed output.
    const videoExt = extname(event.rawPath).replace(/^\./, '') || 'mp4'
    const videoPath = join(dirPath, `recording.${videoExt}`)
    const thumbnailPath = join(dirPath, 'thumbnail.jpg')

    await fs.mkdir(dirPath, { recursive: true })

    const offsetSecs = Math.max(
      0,
      (event.matchStartedAt.getTime() - event.recordingStartedAt.getTime()) / 1000
    )

    await media.trim(event.rawPath, videoPath, offsetSecs, event.durationSecs)
    await media.thumbnail(videoPath, thumbnailPath)

    const metadata = buildMetadata(event, timeline, videoExt)
    await writeMetadata(dirPath, metadata)
    if (event.coach !== undefined) await writeCoachData(dirPath, event.coach)

    await fs.unlink(event.rawPath)

    return {
      id: dirName,
      path: dirPath,
      videoPath,
      thumbnailPath,
      metadata
    }
  }

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------

  // Returns all Mythic+ recordings sorted by date descending (newest first).
  // Directories without a parseable metadata.json are skipped silently
  // (they are surfaced separately via findOrphanedRecordings), and so are arena
  // recordings left over from before Depleted was Mythic+ only.
  async getRecordings(): Promise<Recording[]> {
    const entries = await safeReaddir(this.storagePath)
    const recordings: Recording[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dirPath = join(this.storagePath, entry.name)
      const metadata = await readMetadata(dirPath)

      if (metadata === null || metadata.bracket !== 'mythic-plus' || metadata.mythicPlus === undefined) continue
      recordings.push({
        id: entry.name,
        path: dirPath,
        videoPath: join(dirPath, `recording.${metadata.videoExt ?? 'mp4'}`),
        thumbnailPath: join(dirPath, 'thumbnail.jpg'),
        metadata
      })
    }

    recordings.sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))
    return recordings
  }

  // Deletes a recording directory by id.
  // Rejects if the id looks like a path traversal attempt.
  async deleteRecording(id: string): Promise<void> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) {
      throw new Error(`Invalid recording id: ${id}`)
    }
    await fs.rm(join(this.storagePath, id), { recursive: true, force: true })
  }

  async getCoachData(id: string): Promise<CoachData | null> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return null
    return readCoachData(join(this.storagePath, id))
  }

  // Returns paths of directories that contain a recording video but no metadata.json.
  // These are incomplete recordings left by a crash during post-processing.
  async findOrphanedRecordings(): Promise<string[]> {
    const entries = await safeReaddir(this.storagePath)
    const orphaned: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dirPath = join(this.storagePath, entry.name)
      const [hasVideo, hasMetadata] = await Promise.all([
        hasAnyRecordingVideo(dirPath),
        fileExists(join(dirPath, 'metadata.json'))
      ])

      if (hasVideo && !hasMetadata) orphaned.push(dirPath)
    }

    return orphaned
  }
}

// ---------------------------------------------------------------------------
// FFmpeg wrappers
// ---------------------------------------------------------------------------

// Trims the raw recording to the exact key duration using stream copy.
// -ss before -i enables fast input seek; ≤1 second inaccuracy is acceptable
// because the source was recorded with -g fps (keyframe every second).
function trimVideo(
  runner: FfmpegRunner,
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  offsetSecs: number,
  durationSecs: number
): Promise<void> {
  return runner(ffmpegPath, [
    '-ss',
    offsetSecs.toFixed(3),
    '-i',
    inputPath,
    '-t',
    String(durationSecs),
    '-c',
    'copy',
    '-y',
    outputPath
  ])
}

// Extracts a single frame at 5 seconds as the recording thumbnail.
function generateThumbnail(
  runner: FfmpegRunner,
  ffmpegPath: string,
  videoPath: string,
  thumbnailPath: string
): Promise<void> {
  return runner(ffmpegPath, ['-ss', '5', '-i', videoPath, '-vframes', '1', '-y', thumbnailPath])
}

// ---------------------------------------------------------------------------
// Metadata builder
// ---------------------------------------------------------------------------

// Builds RecordingMetadata from a processing event.
// playerName/playerClass/playerSpec are not yet available from the combat log.
export function buildDirName(event: ProcessingRequiredEvent): string {
  const zone = event.zoneName.replace(/[^a-zA-Z0-9]/g, '')
  const date = formatDateTime(event.matchStartedAt)
  return `${date}_${zone}_M${event.mythicPlus.keystoneLevel}_${event.mythicPlus.outcome}`
}

export function buildMetadata(
  event: ProcessingRequiredEvent,
  timeline: TimelineEvent[],
  videoExt = 'mp4'
): RecordingMetadata {
  return {
    date: event.matchStartedAt.toISOString(),
    zone: event.zoneName,
    bracket: 'mythic-plus',
    result: event.result,
    duration: event.durationSecs,
    videoExt,
    playerName: '',
    playerClass: '',
    playerSpec: '',
    teamComp: event.teamComp,
    knownSpecs: event.knownSpecs,
    events: timeline,
    playerDamageDone: Object.keys(event.playerDamageDone).length > 0 ? event.playerDamageDone : undefined,
    playerDamageTaken: Object.keys(event.playerDamageTaken).length > 0 ? event.playerDamageTaken : undefined,
    playerHealingDone: Object.keys(event.playerHealingDone).length > 0 ? event.playerHealingDone : undefined,
    mythicPlus: event.mythicPlus
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Reads a directory, returning an empty array if the directory does not exist.
async function safeReaddir(dirPath: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

// Recordings are named 'recording.mp4' or 'recording.webm' depending on which
// container WindowCaptureRecorder negotiated for that recording — probe both.
async function hasAnyRecordingVideo(dirPath: string): Promise<boolean> {
  const [mp4, webm] = await Promise.all([
    fileExists(join(dirPath, 'recording.mp4')),
    fileExists(join(dirPath, 'recording.webm'))
  ])
  return mp4 || webm
}

function formatDateTime(date: Date): string {
  // UTC-based to avoid timezone-dependent directory names; colons replaced for filesystem safety.
  return date.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
}
