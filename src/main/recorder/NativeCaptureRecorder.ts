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

import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { CaptureRecorder, RecorderEventMap, RecorderOptions } from './CaptureRecorder'
import { createEventParser, missingHelperMessage, NATIVE_HELPER_NAME, type HelperEvent } from './nativeHelper'

const DEFAULT_BITRATE_KBPS = 8000
const DEFAULT_FPS = 30
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
// Finalizing an .mp4 is quick, but give a long key's last segment room to flush
const STOP_TIMEOUT_MS = 15_000
const STDERR_TAIL_LINES = 20

type Spawner = (command: string, args: string[]) => ChildProcessWithoutNullStreams

interface ActiveRecording {
  proc: ChildProcessWithoutNullStreams
  outputPath: string
  stderrTail: string[]
  // Set while stop() is waiting for the helper to finalize
  onStopped: ((e: HelperEvent | null) => void) | null
}

export class NativeCaptureRecorder extends EventEmitter implements CaptureRecorder {
  private active: ActiveRecording | null = null
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

  async start(outputPath: string, options: RecorderOptions = {}): Promise<void> {
    if (this.active !== null) throw new Error('NativeCaptureRecorder is already recording')

    const helper = this.helperPath()
    if (!existsSync(helper)) throw new Error(missingHelperMessage(helper))

    // The helper always writes MP4
    const mp4Path = outputPath.replace(/\.[^./\\]+$/, '.mp4')
    await mkdir(dirname(mp4Path), { recursive: true })

    const args = [
      'record',
      '--output',
      mp4Path,
      '--fps',
      String(options.fps ?? DEFAULT_FPS),
      '--bitrate-kbps',
      String(options.bitrateKbps ?? DEFAULT_BITRATE_KBPS),
      '--resolution',
      options.resolution && options.resolution.length > 0 ? options.resolution : 'native'
    ]
    if (options.sourceHint !== undefined && options.sourceHint !== 'auto' && options.sourceHint.length > 0) {
      args.push('--window', options.sourceHint)
    }

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

    return new Promise<void>((resolve, reject) => {
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
            resolve()
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
}
