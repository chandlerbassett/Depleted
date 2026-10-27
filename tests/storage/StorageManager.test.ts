import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StorageManager, buildDirName, buildMetadata, ffmpegMediaTools } from '../../src/main/storage/StorageManager'
import { writeMetadata } from '../../src/main/storage/MetadataWriter'
import type { MythicPlusInfo, RecordingMetadata } from '../../src/shared/ipc.types'
import type { ProcessingRequiredEvent } from '../../src/main/recorder/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_START = new Date('2026-04-15T20:00:15.000Z')
const RECORDING_START = new Date('2026-04-15T20:00:00.000Z') // 15 seconds before the key

const MYTHIC_PLUS: MythicPlusInfo = {
  instanceId: 2660,
  challengeModeId: 503,
  keystoneLevel: 12,
  affixIds: [],
  outcome: 'completed',
  totalTimeMs: 1795000,
  score: null,
  encounters: [],
  deathCount: 0,
  deathsByPlayer: {},
  interruptsByPlayer: {}
}

const EVENT: ProcessingRequiredEvent = {
  rawPath: '', // set per test
  zoneName: 'Ara-Kara, City of Echoes',
  result: 'WIN',
  durationSecs: 1813,
  matchStartedAt: KEY_START,
  recordingStartedAt: RECORDING_START,
  timeline: [],
  knownSpecs: {},
  teamComp: [],
  playerDamageDone: {},
  playerDamageTaken: {},
  playerHealingDone: {},
  mythicPlus: MYTHIC_PLUS
}

const SAMPLE_METADATA: RecordingMetadata = {
  date: '2026-04-15T20:00:15.000Z',
  zone: 'Ara-Kara, City of Echoes',
  bracket: 'mythic-plus',
  result: 'WIN',
  duration: 1813,
  playerName: '',
  playerClass: '',
  playerSpec: '',
  teamComp: [],
  knownSpecs: {},
  mythicPlus: MYTHIC_PLUS,
  events: []
}

const KEY_ID = '2026-04-15_20-00-15_AraKaraCityofEchoes_M12_completed'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(join(tmpdir(), 'wow-recorder-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// buildDirName
// ---------------------------------------------------------------------------

describe('buildDirName', () => {
  it('formats a Mythic+ directory name with level and outcome', () => {
    const event: ProcessingRequiredEvent = { ...EVENT, mythicPlus: { ...MYTHIC_PLUS, outcome: 'depleted' } }
    expect(buildDirName(event)).toBe('2026-04-15_20-00-15_AraKaraCityofEchoes_M12_depleted')
  })
})

// ---------------------------------------------------------------------------
// buildMetadata
// ---------------------------------------------------------------------------

describe('buildMetadata', () => {
  it('builds metadata from a key event', () => {
    const meta = buildMetadata(EVENT, [])
    expect(meta.bracket).toBe('mythic-plus')
    expect(meta.result).toBe('WIN')
    expect(meta.duration).toBe(1813)
    expect(meta.zone).toBe('Ara-Kara, City of Echoes')
    expect(meta.mythicPlus.keystoneLevel).toBe(12)
    expect(meta.events).toEqual([])
  })

  it('includes provided timeline events', () => {
    const timeline = [{ timestamp: 12.4, type: 'death-player' as const }]
    const meta = buildMetadata(EVENT, timeline)
    expect(meta.events).toEqual(timeline)
  })
})

// ---------------------------------------------------------------------------
// getRecordings
// ---------------------------------------------------------------------------

describe('StorageManager.getRecordings', () => {
  it('returns an empty array when the storage directory does not exist', async () => {
    const manager = new StorageManager(join(tmpDir, 'nonexistent'))
    expect(await manager.getRecordings()).toEqual([])
  })

  it('returns recordings from valid directories', async () => {
    const id = KEY_ID
    const dirPath = join(tmpDir, id)
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, SAMPLE_METADATA)

    const manager = new StorageManager(tmpDir)
    const recordings = await manager.getRecordings()

    expect(recordings).toHaveLength(1)
    expect(recordings[0]?.id).toBe(id)
    expect(recordings[0]?.metadata.bracket).toBe('mythic-plus')
  })

  it('skips arena recordings from before Depleted was Mythic+ only', async () => {
    const dirPath = join(tmpDir, '2026-04-15_NagrandArena_2v2_WIN')
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, { ...SAMPLE_METADATA, bracket: '2v2' as 'mythic-plus' })

    const manager = new StorageManager(tmpDir)
    expect(await manager.getRecordings()).toEqual([])
  })

  it('skips directories without metadata.json', async () => {
    // Directory with a video but no metadata
    await fs.mkdir(join(tmpDir, 'orphan-dir'))
    await fs.writeFile(join(tmpDir, 'orphan-dir', 'recording.mp4'), '')

    // Directory with metadata
    const id = KEY_ID
    const dirPath = join(tmpDir, id)
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, SAMPLE_METADATA)

    const manager = new StorageManager(tmpDir)
    const recordings = await manager.getRecordings()

    expect(recordings).toHaveLength(1)
    expect(recordings[0]?.id).toBe(id)
  })

  it('sorts recordings newest first', async () => {
    const ids = [
      { id: 'key-13', date: '2026-04-13T18:00:00.000Z' },
      { id: 'key-15', date: '2026-04-15T20:00:00.000Z' },
      { id: 'key-14', date: '2026-04-14T10:00:00.000Z' }
    ]

    for (const { id, date } of ids) {
      const dirPath = join(tmpDir, id)
      await fs.mkdir(dirPath)
      await writeMetadata(dirPath, { ...SAMPLE_METADATA, date })
    }

    const manager = new StorageManager(tmpDir)
    const recordings = await manager.getRecordings()

    expect(recordings[0]?.id).toBe('key-15')
    expect(recordings[2]?.id).toBe('key-13')
  })
})

// ---------------------------------------------------------------------------
// deleteRecording
// ---------------------------------------------------------------------------

describe('StorageManager.deleteRecording', () => {
  it('removes the recording directory', async () => {
    const id = KEY_ID
    const dirPath = join(tmpDir, id)
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, SAMPLE_METADATA)

    const manager = new StorageManager(tmpDir)
    await manager.deleteRecording(id)

    await expect(fs.access(dirPath)).rejects.toThrow()
  })

  it('rejects id with path traversal: ..', async () => {
    const manager = new StorageManager(tmpDir)
    await expect(manager.deleteRecording('..')).rejects.toThrow('Invalid recording id')
  })

  it('rejects id with a path separator', async () => {
    const manager = new StorageManager(tmpDir)
    await expect(manager.deleteRecording('a/b')).rejects.toThrow('Invalid recording id')
  })
})

// ---------------------------------------------------------------------------
// findOrphanedRecordings
// ---------------------------------------------------------------------------

describe('StorageManager.findOrphanedRecordings', () => {
  it('returns empty array when no orphans exist', async () => {
    const id = KEY_ID
    const dirPath = join(tmpDir, id)
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, SAMPLE_METADATA)
    await fs.writeFile(join(dirPath, 'recording.mp4'), '')

    const manager = new StorageManager(tmpDir)
    expect(await manager.findOrphanedRecordings()).toEqual([])
  })

  it('returns path for directory with video but no metadata', async () => {
    const dirPath = join(tmpDir, 'orphan')
    await fs.mkdir(dirPath)
    await fs.writeFile(join(dirPath, 'recording.mp4'), '')

    const manager = new StorageManager(tmpDir)
    const orphaned = await manager.findOrphanedRecordings()

    expect(orphaned).toHaveLength(1)
    expect(orphaned[0]).toBe(dirPath)
  })

  it('ignores directories with neither video nor metadata', async () => {
    await fs.mkdir(join(tmpDir, 'empty-dir'))

    const manager = new StorageManager(tmpDir)
    expect(await manager.findOrphanedRecordings()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// processRecording
// ---------------------------------------------------------------------------

describe('StorageManager.processRecording', () => {
  it('creates output directory, calls runner with correct args, writes metadata, deletes raw', async () => {
    // Create a fake raw file
    const rawPath = join(tmpDir, 'raw_test.mp4')
    await fs.writeFile(rawPath, 'fake video data')

    const event: ProcessingRequiredEvent = { ...EVENT, rawPath }

    // Track runner calls; create the output files FFmpeg would normally produce
    const capturedCalls: { args: string[] }[] = []
    const mockRunner = vi.fn(async (_ffmpegPath: string, args: string[]) => {
      capturedCalls.push({ args })
      // Create the output file specified as the last argument
      const outputFile = args[args.length - 1]
      if (outputFile !== undefined) {
        await fs.writeFile(outputFile, 'fake output')
      }
    })

    const manager = new StorageManager(tmpDir)
    const recording = await manager.processRecording(event, ffmpegMediaTools('/usr/local/bin/ffmpeg', mockRunner))

    // Two FFmpeg calls: trim and thumbnail
    expect(mockRunner).toHaveBeenCalledTimes(2)

    // First call: trim
    const trimArgs = capturedCalls[0]!.args
    expect(trimArgs).toContain('-c')
    expect(trimArgs).toContain('copy')
    // Args: ['-ss', offset, '-i', rawPath, '-t', duration, '-c', 'copy', '-y', output]
    expect(trimArgs[0]).toBe('-ss')
    // Offset should be 15 seconds (matchStartedAt - recordingStartedAt)
    expect(trimArgs[1]).toBe('15.000')
    expect(trimArgs).toContain(rawPath)

    // Second call: thumbnail
    const thumbArgs = capturedCalls[1]!.args
    expect(thumbArgs).toContain('-vframes')
    expect(thumbArgs).toContain('1')

    // metadata.json written correctly
    const metaContent = await fs.readFile(join(recording.path, 'metadata.json'), 'utf8')
    const meta = JSON.parse(metaContent) as RecordingMetadata
    expect(meta.bracket).toBe('mythic-plus')
    expect(meta.result).toBe('WIN')
    expect(meta.zone).toBe('Ara-Kara, City of Echoes')
    expect(meta.duration).toBe(1813)

    // Raw file deleted
    await expect(fs.access(rawPath)).rejects.toThrow()

    // Recording id matches expected dir name
    expect(recording.id).toBe(KEY_ID)
  })

  it('uses offset 0 when matchStartedAt is before recordingStartedAt', async () => {
    const rawPath = join(tmpDir, 'raw.mp4')
    await fs.writeFile(rawPath, '')

    const event: ProcessingRequiredEvent = {
      ...EVENT,
      rawPath,
      matchStartedAt: new Date('2026-04-15T19:59:50.000Z'), // before recording start
      recordingStartedAt: new Date('2026-04-15T20:00:00.000Z')
    }

    const capturedArgs: string[][] = []
    const mockRunner = vi.fn(async (_ffmpegPath: string, args: string[]) => {
      capturedArgs.push(args)
      const output = args[args.length - 1]
      if (output !== undefined) await fs.writeFile(output, '')
    })

    const manager = new StorageManager(tmpDir)
    await manager.processRecording(event, ffmpegMediaTools('/usr/local/bin/ffmpeg', mockRunner))

    // Offset clamped to 0: args[0] = '-ss', args[1] = '0.000'
    expect(capturedArgs[0]?.[1]).toBe('0.000')
  })
})
