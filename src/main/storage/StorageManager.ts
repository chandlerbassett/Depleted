// Manages the recording library and post-processing pipeline.
//
// Post-processing flow (triggered by MythicPlusStateMachine.processingRequired):
//   1. Build output directory name and create it
//   2. Trim raw video to exact key duration (no re-encode; see MediaTools)
//   3. Generate thumbnail from the trimmed video
//   4. Write metadata.json
//   5. Delete the raw (untrimmed) file and its info file
//
// recoverRawRecordings() saves raw files left behind by a crash or force-quit, as
// abandoned keys (or wiped raid pulls), on the next launch.
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
import { join, extname, basename } from 'path'
import { spawn } from 'child_process'
import type { Clip, MythicPlusInfo, RaidInfo, Recording, RecordingMetadata, TimelineEvent } from '@shared/ipc.types'
import { rawInfoPath, type ProcessingRequiredEvent, type RawRecordingInfo } from '../recorder/types'
import { runHelperCommand } from '../recorder/nativeHelper'
import { writeMetadata, readMetadata, writeCoachData, readCoachData } from './MetadataWriter'
import type { CoachData } from '@shared/coach.types'
import type { WclFightLink } from '@shared/wclFight.types'

const SUMMARY_CACHE_FILENAME = 'coach-summaries.json'
const CLIPS_DIRNAME = 'clips'
// clip_12m34s-13m21s.mp4; the range in the name is the clip's place in the recording
const CLIP_NAME_RE = /^clip_(\d+)m(\d{2})s-(\d+)m(\d{2})s(?:_(\d+))?\.(mp4|webm)$/
const WCL_FIGHT_FILENAME = 'wcl-fight.json'
// Recordings show other people's names and the user's play: folders and files are the
// user's only, whatever the folder they chose allows (issue #84)
const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

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

    await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR })

    const offsetSecs = Math.max(
      0,
      (event.matchStartedAt.getTime() - event.recordingStartedAt.getTime()) / 1000
    )

    await media.trim(event.rawPath, videoPath, offsetSecs, event.durationSecs)
    await media.thumbnail(videoPath, thumbnailPath)
    await makePrivate(videoPath, thumbnailPath)

    const metadata = buildMetadata(event, timeline, videoExt)
    await writeMetadata(dirPath, metadata)
    if (event.coach !== undefined) await writeCoachData(dirPath, event.coach)

    await fs.unlink(event.rawPath)
    await fs.rm(rawInfoPath(event.rawPath), { force: true })

    return {
      id: dirName,
      path: dirPath,
      videoPath,
      thumbnailPath,
      metadata,
      clips: []
    }
  }

  // Saves raw recordings that never got processed (the app crashed or was force-quit
  // mid-key) as abandoned keys. Pass only files that existed before recording could
  // start this session. Uses the info file written at key start when there is one;
  // otherwise the zone and start time come from the file name and the level is unknown.
  async recoverRawRecordings(rawPaths: string[], media: MediaTools): Promise<Recording[]> {
    const recovered: Recording[] = []
    for (const rawPath of rawPaths) {
      try {
        const event = await buildRecoveryEvent(rawPath)
        if (event === null) continue
        recovered.push(await this.processRecording(event, media))
        console.warn(`[Storage] Recovered ${rawPath}`)
      } catch (err) {
        console.error(`[Storage] Could not recover ${rawPath}:`, err instanceof Error ? err.message : String(err))
      }
    }
    return recovered
  }

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------

  // Returns all Mythic+ and raid recordings sorted by date descending (newest first).
  // Directories without a parseable metadata.json are skipped silently
  // (they are surfaced separately via findOrphanedRecordings), and so are arena
  // recordings left over from before Depleted recorded PvE.
  async getRecordings(): Promise<Recording[]> {
    const entries = await safeReaddir(this.storagePath)
    const recordings: Recording[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dirPath = join(this.storagePath, entry.name)
      const metadata = await readMetadata(dirPath)

      if (metadata === null || !isPveRecording(metadata)) continue
      recordings.push({
        id: entry.name,
        path: dirPath,
        videoPath: join(dirPath, `recording.${metadata.videoExt ?? 'mp4'}`),
        thumbnailPath: join(dirPath, 'thumbnail.jpg'),
        metadata,
        clips: await listClips(dirPath, entry.name)
      })
    }

    recordings.sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))
    return recordings
  }

  // Deletes a recording directory by id.
  // Rejects if the id looks like a path traversal attempt.
  // remove defaults to deleting for good; the app passes shell.trashItem instead
  async deleteRecording(
    id: string,
    remove: (dirPath: string) => Promise<void> = (dirPath) => fs.rm(dirPath, { recursive: true, force: true })
  ): Promise<void> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) {
      throw new Error(`Invalid recording id: ${id}`)
    }
    await remove(join(this.storagePath, id))
  }

  async getCoachData(id: string): Promise<CoachData | null> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return null
    return readCoachData(join(this.storagePath, id))
  }

  // Trends' per-key summaries, saved next to coach.json so app starts don't redo them.
  // The caller owns the format; anything unreadable comes back as null.
  async readSummaryCache(id: string): Promise<unknown> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return null
    try {
      return JSON.parse(await fs.readFile(join(this.storagePath, id, SUMMARY_CACHE_FILENAME), 'utf8')) as unknown
    } catch {
      return null
    }
  }

  async writeSummaryCache(id: string, cache: unknown): Promise<void> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return
    await fs.writeFile(join(this.storagePath, id, SUMMARY_CACHE_FILENAME), JSON.stringify(cache), { encoding: 'utf8', mode: PRIVATE_FILE })
  }

  // Cuts startSecs..endSecs of a recording into its clips/ folder, without re-encoding
  // (so the cut lands on the nearest keyframe, about a second at most). Returns the path.
  async saveClip(id: string, startSecs: number, endSecs: number, media: MediaTools): Promise<Clip> {
    if (!isRecordingId(id)) throw new Error(`Invalid recording id: ${id}`)
    const dirPath = join(this.storagePath, id)
    const metadata = await readMetadata(dirPath)
    if (metadata === null) throw new Error('Recording not found')
    const start = Math.max(0, startSecs)
    const end = Math.min(metadata.duration, endSecs)
    if (!(end - start >= 1)) throw new Error('A clip needs to be at least a second long')
    const ext = metadata.videoExt ?? 'mp4'
    const clipsDir = join(dirPath, CLIPS_DIRNAME)
    await fs.mkdir(clipsDir, { recursive: true, mode: PRIVATE_DIR })
    const base = `clip_${clockLabel(start)}-${clockLabel(end)}`
    let fileName = `${base}.${ext}`
    for (let n = 2; await fileExists(join(clipsDir, fileName)); n++) fileName = `${base}_${n}.${ext}`
    const clipPath = join(clipsDir, fileName)
    await media.trim(join(dirPath, `recording.${ext}`), clipPath, start, Math.round((end - start) * 1000) / 1000)
    try {
      await media.thumbnail(clipPath, clipThumbnailPath(clipPath))
    } catch (err) {
      console.warn('[Storage] No thumbnail for the clip:', err instanceof Error ? err.message : String(err))
    }
    await makePrivate(clipPath, clipThumbnailPath(clipPath))
    const clip = await readClip(clipsDir, id, fileName)
    if (clip === null) throw new Error('The clip was not written')
    return clip
  }

  // Moves a clip and its thumbnail out of the library. remove defaults to deleting for good.
  async deleteClip(
    clipId: string,
    remove: (path: string) => Promise<void> = (path) => fs.rm(path, { force: true })
  ): Promise<void> {
    const clip = await this.getClip(clipId)
    if (clip === null) throw new Error(`No such clip: ${clipId}`)
    await remove(clip.videoPath)
    if (clip.thumbnailPath !== null) await remove(clip.thumbnailPath)
  }

  async getClip(clipId: string): Promise<Clip | null> {
    const [recordingId, fileName, ...rest] = clipId.split('/')
    if (rest.length > 0 || recordingId === undefined || fileName === undefined || !isRecordingId(recordingId)) return null
    if (!CLIP_NAME_RE.test(fileName)) return null
    return readClip(join(this.storagePath, recordingId, CLIPS_DIRNAME), recordingId, fileName)
  }

  async readWclFight(id: string): Promise<WclFightLink | null> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return null
    try {
      return JSON.parse(await fs.readFile(join(this.storagePath, id, WCL_FIGHT_FILENAME), 'utf8')) as WclFightLink
    } catch {
      return null
    }
  }

  async writeWclFight(id: string, link: WclFightLink): Promise<void> {
    if (!id || id === '..' || id === '.' || id.includes('/') || id.includes('\\')) return
    await fs.writeFile(join(this.storagePath, id, WCL_FIGHT_FILENAME), JSON.stringify(link), { encoding: 'utf8', mode: PRIVATE_FILE })
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

export function buildDirName(event: ProcessingRequiredEvent): string {
  const zone = event.zoneName.replace(/[^a-zA-Z0-9]/g, '')
  const date = formatDateTime(event.matchStartedAt)
  if (event.raid !== undefined) {
    const boss = event.raid.encounterName.replace(/[^a-zA-Z0-9]/g, '')
    return `${date}_${zone}_${boss}_${event.raid.difficulty}_${event.raid.outcome}`
  }
  return `${date}_${zone}_M${event.mythicPlus?.keystoneLevel ?? 0}_${event.mythicPlus?.outcome ?? 'abandoned'}`
}

// Builds RecordingMetadata from a processing event.
export function buildMetadata(
  event: ProcessingRequiredEvent,
  timeline: TimelineEvent[],
  videoExt = 'mp4'
): RecordingMetadata {
  return {
    date: event.matchStartedAt.toISOString(),
    zone: event.zoneName,
    bracket: event.raid !== undefined ? 'raid' : 'mythic-plus',
    result: event.result,
    duration: event.durationSecs,
    videoExt,
    playerName: event.player?.name ?? '',
    playerClass: event.player?.class ?? '',
    playerSpec: event.player?.spec ?? '',
    teamComp: event.teamComp,
    knownSpecs: event.knownSpecs,
    events: timeline,
    playerDamageDone: Object.keys(event.playerDamageDone).length > 0 ? event.playerDamageDone : undefined,
    playerDamageTaken: Object.keys(event.playerDamageTaken).length > 0 ? event.playerDamageTaken : undefined,
    playerHealingDone: Object.keys(event.playerHealingDone).length > 0 ? event.playerHealingDone : undefined,
    mythicPlus: event.mythicPlus,
    raid: event.raid
  }
}

function isPveRecording(metadata: RecordingMetadata): boolean {
  if (metadata.bracket === 'mythic-plus') return metadata.mythicPlus !== undefined
  if (metadata.bracket === 'raid') return metadata.raid !== undefined
  return false
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

const RAW_NAME_RE = /^raw_mplus_(.+)_(\d{8}T\d{6})\.(mp4|webm)$/

export async function buildRecoveryEvent(rawPath: string): Promise<ProcessingRequiredEvent | null> {
  const name = basename(rawPath)
  const match = RAW_NAME_RE.exec(name)
  if (match === null) return null
  const stat = await fs.stat(rawPath)
  if (stat.size === 0) return null
  const info = await readRawInfo(rawPath)

  let zoneName: string
  let matchStartedAt: Date
  let recordingStartedAt: Date
  let mythicPlus: MythicPlusInfo | undefined
  let raid: RaidInfo | undefined
  if (info !== null) {
    zoneName = info.zoneName
    recordingStartedAt = new Date(info.recordingStartedAt)
    const keyStartedAt = new Date(info.keyStartedAt)
    // Same lead-in as a normal save: at most preRollSecs before the key start
    matchStartedAt = new Date(Math.max(recordingStartedAt.getTime(), keyStartedAt.getTime() - info.preRollSecs * 1000))
    if (info.raid !== undefined) {
      raid = {
        instanceId: info.instanceId,
        ...info.raid,
        outcome: 'wipe',
        fightTimeMs: 0,
        deathCount: 0,
        deathsByPlayer: {},
        interruptsByPlayer: {}
      }
    } else {
      mythicPlus = emptyMythicPlus(info.instanceId, info.challengeModeId, info.keystoneLevel, info.affixIds)
    }
  } else {
    // "murder-row" → "Murder Row"; the time is when the recording started (UTC)
    zoneName = match[1]!.split('-').filter((w) => w.length > 0).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
    const ts = match[2]!
    recordingStartedAt = new Date(
      `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`
    )
    matchStartedAt = recordingStartedAt
    mythicPlus = emptyMythicPlus(0, 0, 0, [])
  }
  // The recorder last wrote the file when it stopped
  const durationSecs = Math.max(1, Math.round((stat.mtime.getTime() - matchStartedAt.getTime()) / 1000))

  return {
    rawPath,
    zoneName,
    result: 'LOSS',
    durationSecs,
    matchStartedAt,
    recordingStartedAt,
    timeline: [],
    knownSpecs: {},
    teamComp: [],
    playerDamageDone: {},
    playerDamageTaken: {},
    playerHealingDone: {},
    mythicPlus,
    raid
  }
}

async function readRawInfo(rawPath: string): Promise<RawRecordingInfo | null> {
  try {
    return JSON.parse(await fs.readFile(rawInfoPath(rawPath), 'utf8')) as RawRecordingInfo
  } catch {
    return null
  }
}

function emptyMythicPlus(instanceId: number, challengeModeId: number, keystoneLevel: number, affixIds: number[]): MythicPlusInfo {
  return {
    instanceId,
    challengeModeId,
    keystoneLevel,
    affixIds,
    outcome: 'abandoned',
    totalTimeMs: 0,
    score: null,
    encounters: [],
    deathCount: 0,
    deathsByPlayer: {},
    interruptsByPlayer: {}
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function listClips(dirPath: string, recordingId: string): Promise<Clip[]> {
  const clipsDir = join(dirPath, CLIPS_DIRNAME)
  const clips: Clip[] = []
  for (const entry of await safeReaddir(clipsDir)) {
    if (!entry.isFile() || !CLIP_NAME_RE.test(entry.name)) continue
    const clip = await readClip(clipsDir, recordingId, entry.name)
    if (clip !== null) clips.push(clip)
  }
  return clips.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function readClip(clipsDir: string, recordingId: string, fileName: string): Promise<Clip | null> {
  const m = CLIP_NAME_RE.exec(fileName)
  if (m === null) return null
  const videoPath = join(clipsDir, fileName)
  let createdAt: string
  try {
    createdAt = (await fs.stat(videoPath)).mtime.toISOString()
  } catch {
    return null
  }
  const thumb = clipThumbnailPath(videoPath)
  return {
    id: `${recordingId}/${fileName}`,
    recordingId,
    fileName,
    videoPath,
    thumbnailPath: (await fileExists(thumb)) ? thumb : null,
    start: Number(m[1]) * 60 + Number(m[2]),
    end: Number(m[3]) * 60 + Number(m[4]),
    createdAt
  }
}

function clipThumbnailPath(clipPath: string): string {
  return clipPath.replace(/\.(mp4|webm)$/, '.jpg')
}

// 754.2 → "12m34s", safe in a file name
function clockLabel(secs: number): string {
  const s = Math.floor(secs)
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function isRecordingId(id: string): boolean {
  return !!id && id !== '..' && id !== '.' && !id.includes('/') && !id.includes('\\')
}

// Reads a directory, returning an empty array if the directory does not exist.
async function safeReaddir(dirPath: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

// Files the helper or FFmpeg wrote with the default umask become the user's only. A
// missing one (no thumbnail) is skipped.
async function makePrivate(...paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await fs.chmod(path, PRIVATE_FILE)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[Storage] Could not make ${basename(path)} private:`, err instanceof Error ? err.message : String(err))
      }
    }
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
