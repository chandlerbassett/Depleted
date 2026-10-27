import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeMetadata, readMetadata } from '../../src/main/storage/MetadataWriter'
import type { RecordingMetadata } from '../../src/shared/ipc.types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  mythicPlus: {
    instanceId: 2660,
    challengeModeId: 503,
    keystoneLevel: 12,
    affixIds: [],
    outcome: 'completed',
    totalTimeMs: 1795000,
    score: { dungeon: 334.3, overall: 3807.3 },
    encounters: [],
    deathCount: 0,
    deathsByPlayer: {},
    interruptsByPlayer: {}
  },
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
// Tests
// ---------------------------------------------------------------------------

describe('writeMetadata / readMetadata', () => {
  it('round-trips a key metadata object', async () => {
    await writeMetadata(tmpDir, SAMPLE_METADATA)
    const result = await readMetadata(tmpDir)

    expect(result).toEqual(SAMPLE_METADATA)
  })

  it('writes valid JSON to metadata.json', async () => {
    await writeMetadata(tmpDir, SAMPLE_METADATA)
    const raw = await fs.readFile(join(tmpDir, 'metadata.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = JSON.parse(raw) as RecordingMetadata
    expect(parsed.zone).toBe('Ara-Kara, City of Echoes')
  })

  it('returns null when metadata.json does not exist', async () => {
    const result = await readMetadata(tmpDir)
    expect(result).toBeNull()
  })

  it('returns null when metadata.json contains invalid JSON', async () => {
    await fs.writeFile(join(tmpDir, 'metadata.json'), '{ invalid json }', 'utf8')
    const result = await readMetadata(tmpDir)
    expect(result).toBeNull()
  })
})
