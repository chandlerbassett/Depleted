import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { NativeCaptureRecorder } from '../../src/main/recorder/NativeCaptureRecorder'
import { createEventParser, type HelperEvent } from '../../src/main/recorder/nativeHelper'

// Stand-in for the depleted-capture process: tests drive its stdout and exit.
class FakeHelper extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  stdinText = ''
  killedWith: string | null = null

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => (this.stdinText += chunk.toString()))
  }

  send(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + '\n')
  }

  exit(code: number): void {
    // Let stdout drain before 'close', as a real process would
    setImmediate(() => this.emit('close', code))
  }

  kill(signal: string): boolean {
    this.killedWith = signal
    return true
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

// start() creates the output folder before spawning, so wait for the spawn
async function spawned(args: () => string[]): Promise<void> {
  await vi.waitFor(() => expect(args().length).toBeGreaterThan(0))
}

describe('NativeCaptureRecorder', () => {
  let dir: string
  let helperPath: string
  let helper: FakeHelper
  let spawnArgs: string[]
  let recorder: NativeCaptureRecorder

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-rec-'))
    helperPath = join(dir, 'depleted-capture')
    writeFileSync(helperPath, '')
    helper = new FakeHelper()
    spawnArgs = []
    recorder = new NativeCaptureRecorder(
      () => helperPath,
      (_cmd, args) => {
        spawnArgs = args
        return helper as unknown as ChildProcessWithoutNullStreams
      }
    )
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes options through and resolves on the started event', async () => {
    const started = recorder.start(join(dir, 'raw', 'key.webm'), {
      fps: 60,
      bitrateKbps: 12000,
      codec: 'hevc',
      resolution: '1920x1080',
      sourceHint: 'World of Warcraft'
    })
    await spawned(() => spawnArgs)
    expect(recorder.isRecording()).toBe(false)

    helper.send({ event: 'started', path: join(dir, 'raw', 'key.mp4') })
    await started

    expect(recorder.isRecording()).toBe(true)
    expect(spawnArgs).toEqual([
      'record',
      '--output',
      join(dir, 'raw', 'key.mp4'),
      '--fps',
      '60',
      '--bitrate-kbps',
      '12000',
      '--codec',
      'hevc',
      '--resolution',
      '1920x1080',
      '--window',
      'World of Warcraft'
    ])
  })

  it('does not pass --window for auto-detect', async () => {
    const started = recorder.start(join(dir, 'a.mp4'), { sourceHint: 'auto' })
    await spawned(() => spawnArgs)
    helper.send({ event: 'started' })
    await started
    expect(spawnArgs).not.toContain('--window')
    expect(spawnArgs).toContain('native')
  })

  it('rejects when the helper fails before the first frame', async () => {
    const started = recorder.start(join(dir, 'a.mp4'))
    await spawned(() => spawnArgs)
    helper.send({ event: 'error', message: 'No World of Warcraft window found to capture.' })
    helper.exit(1)
    await expect(started).rejects.toThrow('No World of Warcraft window found')
    expect(recorder.isRecording()).toBe(false)
  })

  it('stop() sends "stop" and resolves with the finalized path', async () => {
    const started = recorder.start(join(dir, 'a.mp4'))
    await spawned(() => spawnArgs)
    helper.send({ event: 'started' })
    await started

    const stopped = recorder.stop()
    expect(recorder.isRecording()).toBe(false)
    await flush()
    expect(helper.stdinText).toBe('stop\n')

    helper.send({ event: 'stopped', path: join(dir, 'a.mp4'), durationSecs: 12.5 })
    helper.exit(0)
    await expect(stopped).resolves.toBe(join(dir, 'a.mp4'))
    await expect(recorder.stop()).rejects.toThrow('not recording')
  })

  it('emits unexpectedStop when the helper dies mid-recording', async () => {
    const started = recorder.start(join(dir, 'a.mp4'))
    await spawned(() => spawnArgs)
    helper.send({ event: 'started' })
    await started

    const stops: { code: number | null; outputPath: string; stderrTail: string[] }[] = []
    recorder.on('unexpectedStop', (e) => stops.push(e))
    helper.send({ event: 'error', message: 'Capture stopped: window closed', path: join(dir, 'a.mp4') })
    helper.exit(1)
    await flush()
    await flush()

    expect(stops).toHaveLength(1)
    expect(stops[0]!.code).toBe(1)
    expect(stops[0]!.outputPath).toBe(join(dir, 'a.mp4'))
    expect(stops[0]!.stderrTail).toContain('Capture stopped: window closed')
    expect(recorder.isRecording()).toBe(false)
  })

  it('refuses to start when the helper binary is missing', async () => {
    rmSync(helperPath)
    await expect(recorder.start(join(dir, 'a.mp4'))).rejects.toThrow('npm run build:native')
  })
})

describe('createEventParser', () => {
  it('handles events split across chunks and ignores non-JSON lines', () => {
    const events: HelperEvent[] = []
    const feed = createEventParser((e) => events.push(e))
    feed(Buffer.from('{"event":"sta'))
    feed(Buffer.from('rted","width":1920}\nnot json\n\n{"event":"stopped"}\n'))
    expect(events).toEqual([{ event: 'started', width: 1920 }, { event: 'stopped' }])
  })
})
