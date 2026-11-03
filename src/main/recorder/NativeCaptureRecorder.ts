// macOS recorder: runs the depleted-capture helper (ScreenCaptureKit capture, hardware
// H.264/HEVC encode via AVAssetWriter) as a child process, one process per recording.
//
//   start(outputPath) → spawn `depleted-capture record …` → resolves on its `started`
//                       event (first frame is in the file)
//   stop()            → write "stop" to its stdin → resolves with the path from its
//                       `stopped` event once the .mp4 is finalized
//
// If the helper dies or reports an error while recording (window closed, game quit),
// `unexpectedStop` fires with whatever file it managed to finalize.
//
// Rolling buffer (pre-roll): startBuffer() runs `depleted-capture buffer`, which keeps
// encoding into a short rolling buffer in its memory. While it runs, start() and stop() are
// commands to that process instead of a new one: start() opens a file that begins with
// the buffered footage (and resolves with when that footage begins), stop() finishes
// the file and leaves the buffer running. stopBuffer() ends the process.

import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { CaptureRecorder, RecorderEventMap, RecorderOptions } from './CaptureRecorder'
import { createEventParser, missingHelperMessage, type HelperEvent } from './nativeHelper'

const DEFAULT_BITRATE_KBPS = 8000
const DEFAULT_FPS = 30
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
// Finalizing an .mp4 is quick, but give a long key's last segment room to flush
const STOP_TIMEOUT_MS = 15_000
// Starting from the buffer copies up to a minute and a half of footage into the file
const BUFFER_START_TIMEOUT_MS = 30_000
// Stopping from the buffer rewrites the whole file from zero (no re-encode; a 4K key at
// 100 Mbps is ~30 GB)
const BUFFER_STOP_TIMEOUT_MS = 10 * 60_000
const BUFFER_QUIT_TIMEOUT_MS = 30_000
const STDERR_TAIL_LINES = 20

type Spawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams

interface ActiveRecording {
  proc: ChildProcessWithoutNullStreams
  outputPath: string
  stderrTail: string[]
  // Set while stop() is waiting for the helper to finalize
  onStopped: ((e: HelperEvent | null) => void) | null
}

interface BufferProcess {
  proc: ChildProcessWithoutNullStreams
  stderrTail: string[]
  // True once the helper reported `buffering`
  ready: boolean
  // The file being recorded from the buffer, while start() … stop()
  recordingPath: string | null
  // The start/stop command waiting for its answer
  pending: PendingCommand | null
  quitting: boolean
  closed: Promise<void>
}

interface PendingCommand {
  kind: 'start' | 'stop'
  settle: (e: HelperEvent | null, error?: string) => void
}

export class NativeCaptureRecorder extends EventEmitter implements CaptureRecorder {
  private active: ActiveRecording | null = null
  private buffer: BufferProcess | null = null
  private capturing = false

  constructor(
    private readonly helperPath: () => string,
    private readonly spawner: Spawner = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  ) {
    super()
  }

  override emit<K extends keyof RecorderEventMap>(event: K, payload: RecorderEventMap[K]): boolean {
    return super.emit(event, payload)
  }

  override on<K extends keyof RecorderEventMap>(event: K, listener: (payload: RecorderEventMap[K]) => void): this {
    return super.on(event, listener)
  }

  isRecording(): boolean {
    return this.capturing
  }

  isBuffering(): boolean {
    return this.buffer !== null && this.buffer.ready && !this.buffer.quitting
  }

  // Resolves with when the file's first frame was captured: before now when it opens
  // with buffered footage.
  async start(outputPath: string, options: RecorderOptions = {}): Promise<Date> {
    if (this.active !== null || this.capturing) throw new Error('NativeCaptureRecorder is already recording')

    // The helper always writes MP4
    const mp4Path = outputPath.replace(/\.[^./\\]+$/, '.mp4')
    if (this.isBuffering()) return this.startFromBuffer(mp4Path)

    const helper = this.helperPath()
    if (!existsSync(helper)) throw new Error(missingHelperMessage(helper))
    await mkdir(dirname(mp4Path), { recursive: true })

    const args = ['record', '--output', mp4Path, ...captureArgs(options)]
    const proc = this.spawner(helper, args)
    const recording: ActiveRecording = { proc, outputPath: mp4Path, stderrTail: [], onStopped: null }
    this.active = recording

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length === 0) continue
        // The helper already prefixes its lines with [depleted-capture]
        console.warn(line)
        recording.stderrTail.push(line)
        if (recording.stderrTail.length > STDERR_TAIL_LINES) recording.stderrTail.shift()
      }
    })

    const startupTimeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    return new Promise<Date>((resolve, reject) => {
      let started = false
      let lastError: string | null = null

      const timer = setTimeout(() => {
        if (started) return
        this.active = null
        proc.kill('SIGKILL')
        reject(new Error(`Capture did not start within ${startupTimeout}ms. ${recording.stderrTail.slice(-3).join(' ')}`))
      }, startupTimeout)

      proc.stdout.on(
        'data',
        createEventParser((e) => {
          if (e.event === 'started' && !started) {
            started = true
            clearTimeout(timer)
            this.capturing = true
            resolve(new Date())
          } else if (e.event === 'stopped') {
            recording.onStopped?.(e)
          } else if (e.event === 'error') {
            lastError = e.message ?? 'unknown error'
          }
        })
      )

      proc.on('error', (err) => {
        lastError = err.message
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (this.active === recording) this.active = null
        const wasCapturing = this.capturing && recording.onStopped === null

        if (!started) {
          reject(new Error(`Capture failed to start: ${lastError ?? recording.stderrTail.slice(-3).join(' ')}`))
          return
        }
        if (recording.onStopped !== null) {
          // stop() is waiting; a clean exit already delivered `stopped`
          recording.onStopped(null)
          return
        }
        if (wasCapturing) {
          this.capturing = false
          const tail = lastError !== null ? [...recording.stderrTail, lastError] : recording.stderrTail
          this.emit('unexpectedStop', { code, outputPath: recording.outputPath, stderrTail: tail })
        }
      })
    })
  }

  stop(): Promise<string> {
    if (this.buffer !== null && this.buffer.recordingPath !== null && this.capturing) return this.stopFromBuffer(this.buffer)
    const recording = this.active
    if (recording === null || !this.capturing) {
      return Promise.reject(new Error('NativeCaptureRecorder is not recording'))
    }
    // Clear now so isRecording() is false and a second stop() is rejected
    this.capturing = false

    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settle(null)
        recording.proc.kill('SIGKILL')
      }, STOP_TIMEOUT_MS)

      const settle = (e: HelperEvent | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.active === recording) this.active = null
        if (e !== null && typeof e.path === 'string') {
          resolve(e.path)
        } else if (existsSync(recording.outputPath)) {
          // Helper exited without a clean `stopped`; keep what's on disk
          console.warn(`[NativeCaptureRecorder] helper exited without finalizing: ${recording.stderrTail.slice(-3).join(' ')}`)
          resolve(recording.outputPath)
        } else {
          reject(new Error(`Recording was not saved: ${recording.stderrTail.slice(-3).join(' ')}`))
        }
      }
      recording.onStopped = settle

      if (recording.proc.stdin.writable) {
        recording.proc.stdin.write('stop\n')
        recording.proc.stdin.end()
      } else {
        recording.proc.kill('SIGTERM')
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rolling buffer
  // ---------------------------------------------------------------------------

  // Starts capturing into a rolling buffer of the last bufferSecs. Resolves once the
  // first frame is encoded. A no-op while one is already running.
  async startBuffer(bufferSecs: number, options: RecorderOptions = {}): Promise<void> {
    if (this.buffer !== null && !this.buffer.quitting) return
    if (this.active !== null || this.capturing) throw new Error('NativeCaptureRecorder is already recording')
    if (this.buffer !== null) await this.buffer.closed

    const helper = this.helperPath()
    if (!existsSync(helper)) throw new Error(missingHelperMessage(helper))

    const args = ['buffer', '--buffer-secs', String(bufferSecs), ...captureArgs(options)]
    const proc = this.spawner(helper, args)
    let markClosed: () => void = () => {}
    const buf: BufferProcess = {
      proc,
      stderrTail: [],
      ready: false,
      recordingPath: null,
      pending: null,
      quitting: false,
      closed: new Promise<void>((r) => (markClosed = r))
    }
    this.buffer = buf

    proc.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length === 0) continue
        console.warn(line)
        buf.stderrTail.push(line)
        if (buf.stderrTail.length > STDERR_TAIL_LINES) buf.stderrTail.shift()
      }
    })

    const startupTimeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    return new Promise<void>((resolve, reject) => {
      let lastError: string | null = null
      // Path of the file the helper finished before a fatal error, if it was recording
      let errorPath: string | null = null

      const timer = setTimeout(() => {
        if (buf.ready) return
        if (this.buffer === buf) this.buffer = null
        proc.kill('SIGKILL')
        reject(new Error(`Capture did not start within ${startupTimeout}ms. ${buf.stderrTail.slice(-3).join(' ')}`))
      }, startupTimeout)

      proc.stdout.on(
        'data',
        createEventParser((e) => {
          if (e.event === 'buffering' && !buf.ready) {
            buf.ready = true
            clearTimeout(timer)
            resolve()
          } else if (e.event === 'started' || e.event === 'stopped') {
            buf.pending?.settle(e)
          } else if (e.event === 'error') {
            if (e.fatal === false) {
              buf.pending?.settle(null, e.message ?? 'unknown error')
            } else {
              lastError = e.message ?? 'unknown error'
              if (typeof e.path === 'string') errorPath = e.path
            }
          }
        })
      )

      proc.on('error', (err) => {
        lastError = err.message
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (this.buffer === buf) this.buffer = null
        markClosed()
        const detail = lastError ?? buf.stderrTail.slice(-3).join(' ')
        if (!buf.ready) {
          reject(new Error(`Capture failed to start: ${detail}`))
          return
        }
        const recordingPath = buf.recordingPath
        buf.recordingPath = null
        if (buf.pending !== null) {
          buf.pending.settle(null, `the capture helper exited: ${detail}`)
          return
        }
        if (recordingPath !== null && this.capturing) {
          this.capturing = false
          const tail = lastError !== null ? [...buf.stderrTail, lastError] : buf.stderrTail
          this.emit('unexpectedStop', { code, outputPath: errorPath ?? recordingPath, stderrTail: tail })
          return
        }
        if (!buf.quitting) this.emit('bufferStopped', { message: detail })
      })
    })
  }

  // Ends the buffer process. Resolves once it has exited.
  async stopBuffer(): Promise<void> {
    const buf = this.buffer
    if (buf === null) return
    if (!buf.quitting) {
      buf.quitting = true
      if (buf.proc.stdin.writable) {
        buf.proc.stdin.write('quit\n')
        buf.proc.stdin.end()
      } else {
        buf.proc.kill('SIGTERM')
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(() => {
        buf.proc.kill('SIGKILL')
        r()
      }, BUFFER_QUIT_TIMEOUT_MS)
    })
    await Promise.race([buf.closed, timeout])
    if (timer !== null) clearTimeout(timer)
  }

  private async startFromBuffer(mp4Path: string): Promise<Date> {
    const buf = this.buffer
    if (buf === null) throw new Error('The capture buffer is not running')
    await mkdir(dirname(mp4Path), { recursive: true })
    const e = await this.bufferCommand(buf, 'start', `start ${mp4Path}`, BUFFER_START_TIMEOUT_MS)
    if (e === null) throw new Error(`Recording did not start: ${buf.stderrTail.slice(-3).join(' ')}`)
    buf.recordingPath = typeof e.path === 'string' ? e.path : mp4Path
    this.capturing = true
    const bufferedSecs = typeof e.bufferedSecs === 'number' && e.bufferedSecs > 0 ? e.bufferedSecs : 0
    return new Date(Date.now() - bufferedSecs * 1000)
  }

  private async stopFromBuffer(buf: BufferProcess): Promise<string> {
    const path = buf.recordingPath ?? ''
    // Clear now so isRecording() is false and a second stop() is rejected
    this.capturing = false
    try {
      const e = await this.bufferCommand(buf, 'stop', 'stop', BUFFER_STOP_TIMEOUT_MS)
      if (e !== null && typeof e.path === 'string') return e.path
    } catch (err) {
      if (!existsSync(path)) throw err
    } finally {
      buf.recordingPath = null
    }
    if (existsSync(path)) {
      console.warn(`[NativeCaptureRecorder] buffer recording not confirmed, keeping ${path}`)
      return path
    }
    throw new Error(`Recording was not saved: ${buf.stderrTail.slice(-3).join(' ')}`)
  }

  // Sends one command to the buffer process and resolves with its answer (null on
  // timeout), or rejects with the error it reported.
  private bufferCommand(
    buf: BufferProcess,
    kind: PendingCommand['kind'],
    line: string,
    timeoutMs: number
  ): Promise<HelperEvent | null> {
    if (buf.pending !== null) return Promise.reject(new Error(`The capture buffer is busy (${buf.pending.kind})`))
    if (!buf.proc.stdin.writable) return Promise.reject(new Error('The capture buffer is not running'))
    return new Promise<HelperEvent | null>((resolve, reject) => {
      const timer = setTimeout(() => settle(null), timeoutMs)
      const settle = (e: HelperEvent | null, error?: string): void => {
        if (buf.pending !== pending) return
        buf.pending = null
        clearTimeout(timer)
        if (error !== undefined) reject(new Error(error))
        else resolve(e)
      }
      const pending: PendingCommand = { kind, settle }
      buf.pending = pending
      buf.proc.stdin.write(`${line}\n`)
    })
  }
}

function captureArgs(options: RecorderOptions): string[] {
  const args = [
    '--fps',
    String(options.fps ?? DEFAULT_FPS),
    '--bitrate-kbps',
    String(options.bitrateKbps ?? DEFAULT_BITRATE_KBPS),
    '--codec',
    options.codec ?? 'h264',
    '--resolution',
    options.resolution && options.resolution.length > 0 ? options.resolution : 'native'
  ]
  if (options.sourceHint !== undefined && options.sourceHint !== 'auto' && options.sourceHint.length > 0) {
    args.push('--window', options.sourceHint)
  }
  return args
}
