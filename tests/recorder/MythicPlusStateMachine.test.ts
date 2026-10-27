import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { CombatLogParser } from '../../src/main/combatlog/CombatLogParser'
import type { ParserEventMap } from '../../src/main/combatlog/CombatLogParser'
import { MythicPlusStateMachine } from '../../src/main/recorder/MythicPlusStateMachine'
import type { ProcessingRequiredEvent } from '../../src/main/recorder/RecorderStateMachine'
import type { CombatLogWatcher } from '../../src/main/combatlog/CombatLogWatcher'
import type { WindowCaptureRecorder } from '../../src/main/recorder/WindowCaptureRecorder'

// ---------------------------------------------------------------------------
// Fakes — a real CombatLogParser behind a minimal watcher, so the fixture log
// exercises parser + state machine end to end.
// ---------------------------------------------------------------------------

class FakeWatcher {
  public readonly parser = new CombatLogParser()

  onParser<K extends keyof ParserEventMap>(event: K, listener: (payload: ParserEventMap[K]) => void): this {
    this.parser.on(event, listener)
    return this
  }

  feed(lines: string[]): void {
    for (const line of lines) this.parser.processLine(line)
  }
}

class FakeRecorder extends EventEmitter {
  private recording = false
  startMock = vi.fn(async (): Promise<void> => {
    this.recording = true
  })
  stopMock = vi.fn(async (): Promise<string> => {
    this.recording = false
    return '/tmp/raw_mplus.webm'
  })
  isRecording(): boolean {
    return this.recording
  }
  start(path: string): Promise<void> {
    return this.startMock(path) as Promise<void>
  }
  stop(): Promise<string> {
    return this.stopMock()
  }
}

const LINES = readFileSync(resolve(__dirname, '../fixtures/sample_mythic_plus.log'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)

function linesUpTo(eventType: string): string[] {
  const idx = LINES.findIndex((l) => l.includes(`  ${eventType},`))
  return LINES.slice(0, idx + 1)
}

// The fixture's key starts at 20:00:05 local time; the recorder "comes up" exactly then
// unless a test says otherwise.
const KEY_START = new Date(2026, 9, 27, 20, 0, 5)

function setup(options: { recorderLagMs?: number; idleTimeoutSecs?: number } = {}): {
  watcher: FakeWatcher
  recorder: FakeRecorder
  machine: MythicPlusStateMachine
  processed: ProcessingRequiredEvent[]
} {
  const watcher = new FakeWatcher()
  const recorder = new FakeRecorder()
  vi.setSystemTime(new Date(KEY_START.getTime() + (options.recorderLagMs ?? 0)))
  const machine = new MythicPlusStateMachine(
    watcher as unknown as CombatLogWatcher,
    recorder as unknown as WindowCaptureRecorder,
    {
      rawRecordingsDir: '/tmp/raw',
      postRollSecs: 8,
      abandonTimeoutSecs: 180,
      idleTimeoutSecs: options.idleTimeoutSecs ?? 3600
    }
  )
  const processed: ProcessingRequiredEvent[] = []
  machine.on('processingRequired', (e) => processed.push(e))
  return { watcher, recorder, machine, processed }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('CombatLogParser — Mythic+ events', () => {
  it('parses CHALLENGE_MODE_START including a zone name with a comma and the affix list', () => {
    const parser = new CombatLogParser()
    const starts: ParserEventMap['challengeModeStart'][] = []
    parser.on('challengeModeStart', (e) => starts.push(e))
    for (const l of LINES) parser.processLine(l)

    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      zoneName: 'Ara-Kara, City of Echoes',
      instanceId: 2660,
      challengeModeId: 503,
      keystoneLevel: 12,
      affixIds: [148, 9, 152, 10]
    })
  })

  it('parses CHALLENGE_MODE_END with rating', () => {
    const parser = new CombatLogParser()
    const ends: ParserEventMap['challengeModeEnd'][] = []
    parser.on('challengeModeEnd', (e) => ends.push(e))
    for (const l of LINES) parser.processLine(l)

    expect(ends[0]).toMatchObject({
      instanceId: 2660,
      success: true,
      keystoneLevel: 12,
      totalTimeMs: 1795000,
      oldRating: 2650.5,
      newRating: 2671.25
    })
  })

  it('parses ENCOUNTER_START / ENCOUNTER_END', () => {
    const parser = new CombatLogParser()
    const starts: ParserEventMap['encounterStart'][] = []
    const ends: ParserEventMap['encounterEnd'][] = []
    parser.on('encounterStart', (e) => starts.push(e))
    parser.on('encounterEnd', (e) => ends.push(e))
    for (const l of LINES) parser.processLine(l)

    expect(starts).toHaveLength(2)
    expect(starts[0]).toMatchObject({ encounterId: 2902, encounterName: 'Ulgrax the Devourer', instanceId: 2660 })
    expect(ends.map((e) => e.success)).toEqual([false, true])
    expect(ends[1]!.fightTimeMs).toBe(80000)
  })

  it('parses 12.x timestamps with a UTC offset and 3-digit milliseconds', () => {
    const parser = new CombatLogParser()
    const starts: ParserEventMap['challengeModeStart'][] = []
    parser.on('challengeModeStart', (e) => starts.push(e))
    // Verbatim shape from a real COMBAT_LOG_VERSION 22 log
    parser.processLine(`10/27/2026 12:59:23.987-4  CHALLENGE_MODE_START,"Kings' Rest",1762,249,20,[10,9,147]`)

    expect(starts[0]).toMatchObject({ zoneName: "Kings' Rest", instanceId: 1762, keystoneLevel: 20, affixIds: [10, 9, 147] })
    expect(starts[0]!.timestamp.toISOString()).toBe('2026-10-27T16:59:23.987Z')
  })

  it('emits zoneChanged for non-arena zones', () => {
    const parser = new CombatLogParser()
    const zones: ParserEventMap['zoneChanged'][] = []
    parser.on('zoneChanged', (e) => zones.push(e))
    parser.processLine(LINES[0]!)
    expect(zones[0]).toMatchObject({ instanceId: 2660, zoneName: 'Ara-Kara, City of Echoes' })
  })
})

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('MythicPlusStateMachine', () => {
  it('starts recording on CHALLENGE_MODE_START', async () => {
    const { watcher, recorder, machine } = setup()
    watcher.feed(linesUpTo('CHALLENGE_MODE_START'))
    await vi.advanceTimersByTimeAsync(0)

    expect(recorder.startMock).toHaveBeenCalledOnce()
    expect(recorder.startMock.mock.calls[0]![0]).toMatch(/raw_mplus_ara-kara--city-of-echoes_/)
    expect(machine.getStatus()).toBe('recording')
  })

  it('records a completed key with bosses, deaths and interrupts', async () => {
    const { watcher, recorder, machine, processed } = setup()
    watcher.feed(LINES)
    await vi.runAllTimersAsync()

    expect(recorder.stopMock).toHaveBeenCalledOnce()
    expect(machine.getStatus()).toBe('idle')
    expect(processed).toHaveLength(1)

    const e = processed[0]!
    expect(e.bracket).toBe('mythic-plus')
    expect(e.result).toBe('WIN')
    expect(e.rawPath).toBe('/tmp/raw_mplus.webm')
    // 20:00:05 → 20:30:00 = 1795s, plus 8s post-roll
    expect(e.durationSecs).toBe(1803)

    const mp = e.mythicPlus!
    expect(mp.outcome).toBe('completed')
    expect(mp.keystoneLevel).toBe(12)
    expect(mp.rating).toEqual({ before: 2650.5, after: 2671.25 })
    expect(mp.encounters).toEqual([
      { encounterId: 2902, name: 'Ulgrax the Devourer', start: 55, end: 85, success: false },
      { encounterId: 2902, name: 'Ulgrax the Devourer', start: 115, end: 195, success: true }
    ])
    expect(mp.deathsByPlayer).toEqual({ 'Tankguy-Illidan-US': 1 })
    expect(mp.deathCount).toBe(1)
    expect(mp.interruptsByPlayer).toEqual({ 'Healgal-Illidan-US': 1 })

    const types = e.timeline.map((ev) => [ev.type, ev.timestamp])
    expect(types).toEqual([
      ['key-start', 0],
      ['interrupt', 25],
      ['death-player', 68],
      ['boss-wipe', 85],
      ['boss-kill', 195],
      ['key-end', 1795]
    ])

    const death = e.timeline.find((ev) => ev.type === 'death-player')!
    expect(death.deathSummary?.map((h) => [h.amount, h.relSecs])).toEqual([
      [40000, -3],
      [60000, -1]
    ])
    expect(e.playerDamageTaken).toEqual({ 'Tankguy-Illidan-US': 100000 })
  })

  it('shifts the timeline when the recorder starts after the key', async () => {
    const { watcher, processed } = setup({ recorderLagMs: 3000 })
    watcher.feed(LINES)
    await vi.runAllTimersAsync()

    const e = processed[0]!
    expect(e.matchStartedAt.getTime()).toBe(KEY_START.getTime() + 3000)
    expect(e.durationSecs).toBe(1800)
    expect(e.timeline.find((ev) => ev.type === 'boss-kill')!.timestamp).toBe(192)
    expect(e.mythicPlus!.encounters[1]!.start).toBe(112)
  })

  it('marks a depleted key as a loss', async () => {
    const { watcher, processed } = setup()
    watcher.feed([
      ...linesUpTo('CHALLENGE_MODE_START'),
      '10/27/2026 20:40:00.0000  CHALLENGE_MODE_END,2660,0,12,2395000,2650.5,2650.5'
    ])
    await vi.runAllTimersAsync()

    expect(processed[0]!.result).toBe('LOSS')
    expect(processed[0]!.mythicPlus!.outcome).toBe('depleted')
  })

  it('saves the key as abandoned after leaving the dungeon for the timeout', async () => {
    const { watcher, recorder, processed } = setup()
    watcher.feed(linesUpTo('ENCOUNTER_START'))
    await vi.advanceTimersByTimeAsync(0)
    watcher.feed(['10/27/2026 20:05:00.0000  ZONE_CHANGE,2552,"Dornogal",0'])

    await vi.advanceTimersByTimeAsync(179_000)
    expect(recorder.stopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(recorder.stopMock).toHaveBeenCalledOnce()
    const mp = processed[0]!.mythicPlus!
    expect(mp.outcome).toBe('abandoned')
    // The boss pull that was open when we left is closed out as a wipe
    expect(mp.encounters).toHaveLength(1)
    expect(mp.encounters[0]!.success).toBe(false)
  })

  it('keeps recording if the player comes back before the timeout', async () => {
    const { watcher, recorder, processed } = setup()
    watcher.feed(linesUpTo('CHALLENGE_MODE_START'))
    await vi.advanceTimersByTimeAsync(0)
    watcher.feed([
      '10/27/2026 20:05:00.0000  ZONE_CHANGE,2552,"Dornogal",0',
      '10/27/2026 20:06:00.0000  ZONE_CHANGE,2660,"Ara-Kara, City of Echoes",8'
    ])
    await vi.advanceTimersByTimeAsync(600_000)

    expect(recorder.stopMock).not.toHaveBeenCalled()
    expect(processed).toHaveLength(0)
  })

  it('closes an open key as abandoned when a new key starts', async () => {
    const { watcher, recorder, processed } = setup()
    watcher.feed(linesUpTo('CHALLENGE_MODE_START'))
    await vi.advanceTimersByTimeAsync(0)
    watcher.feed(['10/27/2026 20:10:00.0000  CHALLENGE_MODE_START,"Ara-Kara, City of Echoes",2660,503,12,[148,9,152,10]'])
    await vi.advanceTimersByTimeAsync(0)

    expect(processed).toHaveLength(1)
    expect(processed[0]!.mythicPlus!.outcome).toBe('abandoned')
    expect(recorder.startMock).toHaveBeenCalledTimes(2)
  })

  it('does not start when the recorder is already busy', async () => {
    const { watcher, recorder, machine } = setup()
    await recorder.start('/tmp/arena.mp4')
    recorder.startMock.mockClear()

    watcher.feed(linesUpTo('CHALLENGE_MODE_START'))
    await vi.advanceTimersByTimeAsync(0)

    expect(recorder.startMock).not.toHaveBeenCalled()
    expect(machine.getStatus()).toBe('idle')
  })

  it('closes the key as abandoned when the log goes quiet', async () => {
    // Seen on a real Kings' Rest log: no CHALLENGE_MODE_END and no zone change, the log
    // just stopped after the third boss.
    const { watcher, recorder, processed } = setup({ idleTimeoutSecs: 300 })
    watcher.feed(linesUpTo('ENCOUNTER_END'))
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(270_000)
    expect(recorder.stopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(recorder.stopMock).toHaveBeenCalledOnce()
    const e = processed[0]!
    expect(e.mythicPlus!.outcome).toBe('abandoned')
    // Ends at the last log line seen (20:01:30, the wipe), not when the timer fired
    expect(e.durationSecs).toBe(85)
  })

  it('treats a 0/0 rating on CHALLENGE_MODE_END as no rating', async () => {
    const { watcher, processed } = setup()
    watcher.feed([
      ...linesUpTo('CHALLENGE_MODE_START'),
      '10/27/2026 20:10:00.0000  CHALLENGE_MODE_END,2660,0,0,0,0.000000,0.000000'
    ])
    await vi.runAllTimersAsync()
    expect(processed[0]!.mythicPlus!.rating).toBeNull()
    expect(processed[0]!.mythicPlus!.outcome).toBe('abandoned')
  })

  it('ignores feign death and non-party deaths', async () => {
    const { watcher, processed } = setup()
    watcher.feed([
      ...linesUpTo('CHALLENGE_MODE_START'),
      '10/27/2026 20:01:00.0000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1329-0A000003,"Hunter-Illidan-US",0x512,0x0,1',
      '10/27/2026 20:01:01.0000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-1329-0A000009,"Stranger-Illidan-US",0x548,0x0,0',
      LINES[LINES.length - 1]!
    ])
    await vi.runAllTimersAsync()

    expect(processed[0]!.mythicPlus!.deathCount).toBe(0)
  })
})
