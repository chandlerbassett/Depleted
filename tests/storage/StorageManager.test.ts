import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StorageManager, buildDirName, buildMetadata } from '../../src/main/storage/StorageManager'
import { writeMetadata } from '../../src/main/storage/MetadataWriter'
import type { RecordingMetadata } from '../../src/shared/ipc.types'
import type { ProcessingRequiredEvent } from '../../src/main/recorder/RecorderStateMachine'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MATCH_START = new Date('2026-04-15T20:00:15.000Z')
const RECORDING_START = new Date('2026-04-15T20:00:00.000Z') // 15 seconds before match

const EVENT_2V2: ProcessingRequiredEvent = {
  rawPath: '', // set per test
  zoneName: 'Nagrand Arena',
  bracket: '2v2',
  result: 'WIN',
  durationSecs: 187,
  matchStartedAt: MATCH_START,
  recordingStartedAt: RECORDING_START,
  timeline: [],
  knownSpecs: {},
  healerNames: [],
  teamComp: [],
  enemyComp: [],
  playerRatings: {},
  playerAbsorb: {},
  playerDamageDone: {},
  playerDamageTaken: {},
  playerHealingDone: {},
  detectedMistakes: [],
  teamDmgBySecond: [],
  enemyDmgBySecond: [],
  teamHealBySecond: [],
  enemyHealBySecond: []
}

const EVENT_SS_R3: ProcessingRequiredEvent = {
  rawPath: '',
  zoneName: "Tiger's Peak",
  bracket: 'solo-shuffle',
  result: 'LOSS',
  durationSecs: 90,
  matchStartedAt: MATCH_START,
  recordingStartedAt: RECORDING_START,
  roundNumber: 3,
  sessionId: '2026-04-15T20:00:00.000Z',
  timeline: [],
  knownSpecs: {},
  healerNames: [],
  teamComp: [],
  enemyComp: [],
  playerRatings: {},
  playerAbsorb: {},
  playerDamageDone: {},
  playerDamageTaken: {},
  playerHealingDone: {},
  detectedMistakes: [],
  teamDmgBySecond: [],
  enemyDmgBySecond: [],
  teamHealBySecond: [],
  enemyHealBySecond: []
}

const SAMPLE_METADATA: RecordingMetadata = {
  date: '2026-04-15T20:00:15.000Z',
  zone: 'Nagrand Arena',
  bracket: '2v2',
  result: 'WIN',
  duration: 187,
  playerName: '',
  playerClass: '',
  playerSpec: '',
  teamComp: [],
  enemyComp: [],
  rating: null,
  events: []
}

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
    const event: ProcessingRequiredEvent = {
      ...EVENT_2V2,
      zoneName: 'Ara-Kara, City of Echoes',
      bracket: 'mythic-plus',
      mythicPlus: {
        instanceId: 2660,
        challengeModeId: 503,
        keystoneLevel: 12,
        affixIds: [],
        outcome: 'depleted',
        totalTimeMs: 2395000,
        rating: null,
        encounters: [],
        deathCount: 0,
        deathsByPlayer: {},
        interruptsByPlayer: {}
      }
    }
    expect(buildDirName(event)).toBe('2026-04-15_20-00-15_AraKaraCityofEchoes_M12_depleted')
    expect(buildMetadata(event, []).mythicPlus?.keystoneLevel).toBe(12)
  })

  it('formats a 2v2 directory name correctly', () => {
    const name = buildDirName(EVENT_2V2)
    expect(name).toBe('2026-04-15_20-00-15_NagrandArena_2v2_WIN')
  })

  it('formats a 3v3 directory name correctly', () => {
    const event: ProcessingRequiredEvent = {
      ...EVENT_2V2,
      bracket: '3v3',
      result: 'LOSS'
    }
    expect(buildDirName(event)).toBe('2026-04-15_20-00-15_NagrandArena_3v3_LOSS')
  })

  it('formats a Solo Shuffle directory name as sessionDir/roundDir', () => {
    const name = buildDirName(EVENT_SS_R3)
    // Session dir uses zone-entry time (sessionId = '2026-04-15T20:00:00.000Z')
    expect(name).toBe('2026-04-15_20-00-00_TigersPeak_SoloShuffle/R3_LOSS')
  })

  it('strips non-alphanumeric characters from zone name', () => {
    const event: ProcessingRequiredEvent = {
      ...EVENT_2V2,
      zoneName: "Blade's Edge Arena"
    }
    expect(buildDirName(event)).toBe('2026-04-15_20-00-15_BladesEdgeArena_2v2_WIN')
  })
})

// ---------------------------------------------------------------------------
// buildMetadata
// ---------------------------------------------------------------------------

describe('buildMetadata', () => {
  it('builds metadata from a 2v2 event', () => {
    const meta = buildMetadata(EVENT_2V2, [])
    expect(meta.bracket).toBe('2v2')
    expect(meta.result).toBe('WIN')
    expect(meta.duration).toBe(187)
    expect(meta.zone).toBe('Nagrand Arena')
    expect(meta.round).toBeUndefined()
    expect(meta.sessionId).toBeUndefined()
    expect(meta.events).toEqual([])
  })

  it('includes round and sessionId for Solo Shuffle', () => {
    const meta = buildMetadata(EVENT_SS_R3, [])
    expect(meta.bracket).toBe('solo-shuffle')
    expect(meta.round).toBe(3)
    expect(meta.sessionId).toBe('2026-04-15T20:00:00.000Z')
  })

  it('includes provided timeline events', () => {
    const timeline = [{ timestamp: 12.4, type: 'death-enemy' as const }]
    const meta = buildMetadata(EVENT_2V2, timeline)
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
    const id = '2026-04-15_NagrandArena_2v2_WIN'
    const dirPath = join(tmpDir, id)
    await fs.mkdir(dirPath)
    await writeMetadata(dirPath, SAMPLE_METADATA)

    const manager = new StorageManager(tmpDir)
    const recordings = await manager.getRecordings()

    expect(recordings).toHaveLength(1)
    expect(recordings[0]?.id).toBe(id)
    expect(recordings[0]?.metadata.bracket).toBe('2v2')
  })

  it('skips directories without metadata.json', async () => {
    // Directory with a video but no metadata
    await fs.mkdir(join(tmpDir, 'orphan-dir'))
    await fs.writeFile(join(tmpDir, 'orphan-dir', 'recording.mp4'), '')

    // Directory with metadata
    const id = '2026-04-15_NagrandArena_2v2_WIN'
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
      { id: '2026-04-13_NagrandArena_2v2_WIN', date: '2026-04-13T18:00:00.000Z' },
      { id: '2026-04-15_NagrandArena_2v2_WIN', date: '2026-04-15T20:00:00.000Z' },
      { id: '2026-04-14_NagrandArena_2v2_LOSS', date: '2026-04-14T10:00:00.000Z' }
    ]

    for (const { id, date } of ids) {
      const dirPath = join(tmpDir, id)
      await fs.mkdir(dirPath)
      await writeMetadata(dirPath, { ...SAMPLE_METADATA, date })
    }

    const manager = new StorageManager(tmpDir)
    const recordings = await manager.getRecordings()

    expect(recordings[0]?.id).toBe('2026-04-15_NagrandArena_2v2_WIN')
    expect(recordings[2]?.id).toBe('2026-04-13_NagrandArena_2v2_WIN')
  })
})

// ---------------------------------------------------------------------------
// deleteRecording
// ---------------------------------------------------------------------------

describe('StorageManager.deleteRecording', () => {
  it('removes the recording directory', async () => {
    const id = '2026-04-15_NagrandArena_2v2_WIN'
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

  it('accepts a valid sessionDir/roundDir id (solo-shuffle nested format)', async () => {
    // Create a solo-shuffle session dir with a round subdir containing a recording
    const manager = new StorageManager(tmpDir)
    const sessionDir = join(tmpDir, 'session')
    const roundDir = join(sessionDir, 'R1_WIN')
    await fs.mkdir(roundDir, { recursive: true })
    await fs.writeFile(join(roundDir, 'recording.mp4'), '')
    await expect(manager.deleteRecording('session/R1_WIN')).resolves.not.toThrow()
  })

  it('rejects id with more than one path segment', async () => {
    const manager = new StorageManager(tmpDir)
    await expect(manager.deleteRecording('a/b/c')).rejects.toThrow('Invalid recording id')
  })
})

// ---------------------------------------------------------------------------
// findOrphanedRecordings
// ---------------------------------------------------------------------------

describe('StorageManager.findOrphanedRecordings', () => {
  it('returns empty array when no orphans exist', async () => {
    const id = '2026-04-15_NagrandArena_2v2_WIN'
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

    const event: ProcessingRequiredEvent = { ...EVENT_2V2, rawPath }

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

    const manager = new StorageManager(tmpDir, mockRunner)
    const recording = await manager.processRecording(event, '/usr/local/bin/ffmpeg')

    // Two FFmpeg calls: trim and thumbnail
    expect(mockRunner).toHaveBeenCalledTimes(2)

    // First call: trim
    const trimArgs = capturedCalls[0]!.args
    expect(trimArgs).toContain('-c')
    expect(trimArgs).toContain('copy')
    // Args: ['-ss', offset, '-i', rawPath, '-t', duration, '-c', 'copy', '-y', output]
    expect(trimArgs[0]).toBe('-ss')
    // Offset should be ~15 seconds (matchStartedAt - recordingStartedAt)
    expect(trimArgs[1]).toBe('15.000')
    expect(trimArgs).toContain(rawPath)

    // Second call: thumbnail
    const thumbArgs = capturedCalls[1]!.args
    expect(thumbArgs).toContain('-vframes')
    expect(thumbArgs).toContain('1')

    // metadata.json written correctly
    const metaContent = await fs.readFile(join(recording.path, 'metadata.json'), 'utf8')
    const meta = JSON.parse(metaContent) as RecordingMetadata
    expect(meta.bracket).toBe('2v2')
    expect(meta.result).toBe('WIN')
    expect(meta.zone).toBe('Nagrand Arena')
    expect(meta.duration).toBe(187)

    // Raw file deleted
    await expect(fs.access(rawPath)).rejects.toThrow()

    // Recording id matches expected dir name
    expect(recording.id).toBe('2026-04-15_20-00-15_NagrandArena_2v2_WIN')
  })

  it('keeps raw file until all rounds processed, then deletes it', async () => {
    const rawPath = join(tmpDir, 'raw_ss.mp4')
    await fs.writeFile(rawPath, 'fake video data')

    const mockRunner = vi.fn(async (_ffmpegPath: string, args: string[]) => {
      const output = args[args.length - 1]
      if (output !== undefined) await fs.writeFile(output, 'fake output')
    })

    const manager = new StorageManager(tmpDir, mockRunner)

    // Process rounds 1 and 2 of a 3-round session sharing the same raw file
    await manager.processRecording(
      { ...EVENT_SS_R3, rawPath, roundNumber: 1, totalRoundsInSession: 3 },
      '/usr/local/bin/ffmpeg'
    )
    // Raw file still exists after round 1
    await expect(fs.access(rawPath)).resolves.toBeUndefined()

    await manager.processRecording(
      { ...EVENT_SS_R3, rawPath, roundNumber: 2, totalRoundsInSession: 3 },
      '/usr/local/bin/ffmpeg'
    )
    // Raw file still exists after round 2
    await expect(fs.access(rawPath)).resolves.toBeUndefined()

    await manager.processRecording(
      { ...EVENT_SS_R3, rawPath, roundNumber: 3, totalRoundsInSession: 3 },
      '/usr/local/bin/ffmpeg'
    )
    // Raw file deleted after last round
    await expect(fs.access(rawPath)).rejects.toThrow()
  })

  it('uses offset 0 when matchStartedAt is before recordingStartedAt', async () => {
    const rawPath = join(tmpDir, 'raw.mp4')
    await fs.writeFile(rawPath, '')

    const event: ProcessingRequiredEvent = {
      ...EVENT_2V2,
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

    const manager = new StorageManager(tmpDir, mockRunner)
    await manager.processRecording(event, '/usr/local/bin/ffmpeg')

    // Offset clamped to 0: args[0] = '-ss', args[1] = '0.000'
    expect(capturedArgs[0]?.[1]).toBe('0.000')
  })
})
