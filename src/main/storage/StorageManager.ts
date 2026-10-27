// Manages the recording library and post-processing pipeline.
//
// Post-processing flow (triggered by RecorderStateMachine.processingRequired):
//   1. Build output directory name and create it
//   2. Trim raw video to exact match/key duration (no re-encode; see MediaTools)
//   3. Generate thumbnail from the trimmed video
//   4. Write metadata.json
//   5. Delete the raw (untrimmed) file
//
// The trim offset is the wall-clock difference between when recording started
// (on ZONE_CHANGE) and when the match began (ARENA_MATCH_START timestamp).
//
// Library operations:
//   getRecordings()          — scan storage directory, return all Recording[]
//   deleteRecording(id)      — remove a recording directory
//   findOrphanedRecordings() — directories that have a recording video but no metadata.json

import { promises as fs } from 'fs'
import { join, extname } from 'path'
import { spawn } from 'child_process'
import type { Recording, RecordingMetadata, TimelineEvent } from '@shared/ipc.types'
import type { ProcessingRequiredEvent } from '../recorder/RecorderStateMachine'
import { runHelperCommand } from '../recorder/nativeHelper'
import { writeMetadata, readMetadata } from './MetadataWriter'

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
  // Tracks how many rounds still need to be processed for each raw file path.
  // The raw file is deleted only when all rounds sharing it have been processed.
  private readonly rawProcessingCounts = new Map<string, number>()

  constructor(storagePath: string) {
    this.storagePath = storagePath
  }

  // -------------------------------------------------------------------------
  // Post-processing
  // -------------------------------------------------------------------------

  // Trims, thumbnails, and stores a completed arena recording.
  // Called by subscribing to RecorderStateMachine.processingRequired.
  // timeline is empty in Stage 5 and populated in Stage 8.
  async processRecording(
    event: ProcessingRequiredEvent,
    media: MediaTools,
    timeline: TimelineEvent[] = []
  ): Promise<Recording> {
    const dirName = buildDirName(event)
    // dirName may be 'sessionDir/roundDir' for solo-shuffle or a flat name for other brackets.
    const dirPath = join(this.storagePath, ...dirName.split('/'))
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

    // For multi-round sessions (solo shuffle), all rounds share the same raw file.
    // Delete it only after the last round has been processed.
    const totalRounds = event.totalRoundsInSession ?? 1
    if (totalRounds > 1) {
      const remaining = (this.rawProcessingCounts.get(event.rawPath) ?? totalRounds) - 1
      if (remaining <= 0) {
        this.rawProcessingCounts.delete(event.rawPath)
        await fs.unlink(event.rawPath)
      } else {
        this.rawProcessingCounts.set(event.rawPath, remaining)
      }
    } else {
      await fs.unlink(event.rawPath)
    }

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

  // Returns all valid recordings sorted by date descending (newest first).
  // Directories without a parseable metadata.json are skipped silently
  // (they are surfaced separately via findOrphanedRecordings).
  async getRecordings(): Promise<Recording[]> {
    const entries = await safeReaddir(this.storagePath)
    const recordings: Recording[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dirPath = join(this.storagePath, entry.name)
      const metadata = await readMetadata(dirPath)

      if (metadata !== null) {
        // Flat recording (non-solo-shuffle, or old-format solo-shuffle round)
        recordings.push({
          id: entry.name,
          path: dirPath,
          videoPath: join(dirPath, `recording.${metadata.videoExt ?? 'mp4'}`),
          thumbnailPath: join(dirPath, 'thumbnail.jpg'),
          metadata
        })
        continue
      }

      // No metadata at top level — scan subdirs (solo-shuffle session folder)
      const subEntries = await safeReaddir(dirPath)
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue
        const subDirPath = join(dirPath, sub.name)
        const subMetadata = await readMetadata(subDirPath)
        if (subMetadata === null) continue
        recordings.push({
          id: `${entry.name}/${sub.name}`,
          path: subDirPath,
          videoPath: join(subDirPath, `recording.${subMetadata.videoExt ?? 'mp4'}`),
          thumbnailPath: join(subDirPath, 'thumbnail.jpg'),
          metadata: subMetadata
        })
      }
    }

    recordings.sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))
    return recordings
  }

  // Deletes a recording directory by id.
  // Rejects if the id looks like a path traversal attempt.
  async deleteRecording(id: string): Promise<void> {
    const parts = id.split('/')
    if (
      parts.length > 2 ||
      parts.some((p) => !p || p === '..' || p === '.' || p.includes('\\'))
    ) {
      throw new Error(`Invalid recording id: ${id}`)
    }
    const dirPath = join(this.storagePath, ...parts)
    await fs.rm(dirPath, { recursive: true, force: true })

    // If a single round was deleted, remove the parent session dir when it is now empty.
    if (parts.length === 2) {
      const sessionDir = join(this.storagePath, parts[0]!)
      const remaining = (await safeReaddir(sessionDir)).filter((e) => e.isDirectory())
      if (remaining.length === 0) {
        await fs.rm(sessionDir, { recursive: true, force: true })
      }
    }
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

      if (hasVideo && !hasMetadata) {
        orphaned.push(dirPath)
        continue
      }

      // No video at top level — check subdirs (solo-shuffle session folder)
      if (!hasVideo) {
        const subEntries = await safeReaddir(dirPath)
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue
          const subDirPath = join(dirPath, sub.name)
          const [hasSubVideo, hasSubMetadata] = await Promise.all([
            hasAnyRecordingVideo(subDirPath),
            fileExists(join(subDirPath, 'metadata.json'))
          ])
          if (hasSubVideo && !hasSubMetadata) orphaned.push(subDirPath)
        }
      }
    }

    return orphaned
  }
}

// ---------------------------------------------------------------------------
// FFmpeg wrappers
// ---------------------------------------------------------------------------

// Trims the raw recording to the exact match duration using stream copy.
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
// playerName/playerClass/playerSpec are not yet available from the combat log — they
// will be populated in a later stage. teamComp/enemyComp come from
// RecorderStateMachine.buildTeamRosters() (COMBATANT_INFO-derived, reliable); empty
// arrays mean it couldn't be resolved, in which case the renderer falls back to its
// own event-based heuristic (see VideoPlayer.vue derivedTeams).
// rating is not yet tracked here; it will be added when ARENA_MATCH_STATS
// parsing is extended to feed data into processRecording.
export function buildDirName(event: ProcessingRequiredEvent): string {
  const zone = event.zoneName.replace(/[^a-zA-Z0-9]/g, '')

  if (event.bracket === 'solo-shuffle') {
    // Use zone-entry time (sessionId) so all rounds share the same session dir name,
    // and multiple sessions on the same day are distinguished by time.
    const sessionTime = event.sessionId ? new Date(event.sessionId) : event.matchStartedAt
    const sessionDir = `${formatDateTime(sessionTime)}_${zone}_SoloShuffle`
    const roundDir = `R${event.roundNumber ?? 1}_${event.result}`
    return `${sessionDir}/${roundDir}`
  }

  const date = formatDateTime(event.matchStartedAt)
  if (event.bracket === 'mythic-plus' && event.mythicPlus !== undefined) {
    return `${date}_${zone}_M${event.mythicPlus.keystoneLevel}_${event.mythicPlus.outcome}`
  }
  return `${date}_${zone}_${event.bracket}_${event.result}`
}

export function buildMetadata(
  event: ProcessingRequiredEvent,
  timeline: TimelineEvent[],
  videoExt = 'mp4'
): RecordingMetadata {
  const metadata: RecordingMetadata = {
    date: event.matchStartedAt.toISOString(),
    zone: event.zoneName,
    bracket: event.bracket,
    result: event.result,
    duration: event.durationSecs,
    videoExt,
    playerName: '',
    playerClass: '',
    playerSpec: '',
    teamComp: event.teamComp,
    enemyComp: event.enemyComp,
    knownSpecs: event.knownSpecs,
    healerNames: event.healerNames,
    rating:
      event.ratingBefore !== undefined && event.ratingAfter !== undefined
        ? { before: event.ratingBefore, after: event.ratingAfter }
        : null,
    events: timeline,
    playerRatings: Object.keys(event.playerRatings).length > 0 ? event.playerRatings : undefined,
    playerAbsorb: Object.keys(event.playerAbsorb).length > 0 ? event.playerAbsorb : undefined,
    playerDamageDone: Object.keys(event.playerDamageDone).length > 0 ? event.playerDamageDone : undefined,
    playerDamageTaken: Object.keys(event.playerDamageTaken).length > 0 ? event.playerDamageTaken : undefined,
    playerHealingDone: Object.keys(event.playerHealingDone).length > 0 ? event.playerHealingDone : undefined,
    mistakes: event.detectedMistakes.length > 0 ? event.detectedMistakes : undefined,
    teamDmgBySecond: event.teamDmgBySecond.length > 0 ? event.teamDmgBySecond : undefined,
    enemyDmgBySecond: event.enemyDmgBySecond.length > 0 ? event.enemyDmgBySecond : undefined,
    teamHealBySecond: event.teamHealBySecond.length > 0 ? event.teamHealBySecond : undefined,
    enemyHealBySecond: event.enemyHealBySecond.length > 0 ? event.enemyHealBySecond : undefined
  }

  if (event.mythicPlus !== undefined) {
    metadata.mythicPlus = event.mythicPlus
  }

  if (event.bracket === 'solo-shuffle') {
    metadata.round = event.roundNumber
    metadata.sessionId = event.sessionId
  }

  return metadata
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
// container WindowCaptureRecorder negotiated for that match — probe both.
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
