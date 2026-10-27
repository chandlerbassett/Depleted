// Captures a specific window (the WoW client) + system audio via Electron's
// desktopCapturer + getDisplayMedia + MediaRecorder, running in a dedicated hidden
// BrowserWindow (created per-recording, destroyed on stop — mirrors the old FFmpeg
// spawn/kill lifecycle so RecorderStateMachine needs minimal changes).
//
// Recording pipeline:
//   start(outputPath) → hidden window created → session.setDisplayMediaRequestHandler
//                        resolves the chosen source + system-audio loopback →
//                        MediaRecorder starts in the hidden renderer → resolves once
//                        the first chunk confirms capture is actually running
//   stop()            → hidden renderer's MediaRecorder.stop() flushes the final chunk →
//                        write stream closed → hidden window destroyed → resolves with
//                        the final file path (extension depends on the negotiated
//                        MediaRecorder mimeType — mp4 preferred, webm fallback)
//
// FFmpeg is NOT used here — it remains only for StorageManager's post-processing
// (trim + thumbnail), identical on macOS and Windows.

import { EventEmitter } from 'events'
import { BrowserWindow, ipcMain, session } from 'electron'
import type { IpcMainEvent } from 'electron'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_STARTED,
  CAPTURE_CHUNK,
  CAPTURE_FINISHED,
  CAPTURE_ERROR,
  type CaptureStartedPayload,
  type CaptureErrorPayload
} from '@shared/captureIpc.types'
import { resolveCaptureSource } from './sourceResolver'
import type { CaptureRecorder, RecorderEventMap, RecorderOptions } from './CaptureRecorder'

export type { RecorderOptions } from './CaptureRecorder'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BITRATE_KBPS = 8000
const DEFAULT_FPS = 30
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const STOP_FLUSH_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// WindowCaptureRecorder
// ---------------------------------------------------------------------------

export class WindowCaptureRecorder extends EventEmitter implements CaptureRecorder {
  private hiddenWindow: BrowserWindow | null = null
  private writeStream: WriteStream | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private currentOutputPath: string | null = null
  private capturing = false

  // Set immediately before each start()'s hidden-window round trip; consumed by the
  // session-global setDisplayMediaRequestHandler registered once in the constructor.
  private pendingSource: Electron.DesktopCapturerSource | null = null

  private static handlerRegistered = false

  override emit<K extends keyof RecorderEventMap>(event: K, payload: RecorderEventMap[K]): boolean {
    return super.emit(event, payload)
  }

  override on<K extends keyof RecorderEventMap>(
    event: K,
    listener: (payload: RecorderEventMap[K]) => void
  ): this {
    return super.on(event, listener)
  }

  constructor() {
    super()
    this.registerDisplayMediaHandler()
  }

  // session.setDisplayMediaRequestHandler is a single global hook per session — only
  // register once even if multiple WindowCaptureRecorder instances exist (there won't
  // be, in practice, but this guards against accidental double-registration, which
  // Electron does not allow).
  private registerDisplayMediaHandler(): void {
    if (WindowCaptureRecorder.handlerRegistered) return
    WindowCaptureRecorder.handlerRegistered = true

    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        if (this.pendingSource === null) {
          // No recording in flight — deny any stray getDisplayMedia call rather than
          // silently granting access to an arbitrary window.
          callback({})
          return
        }
        callback({ video: this.pendingSource, audio: 'loopback' })
      },
      { useSystemPicker: false }
    )
  }

  isRecording(): boolean {
    return this.capturing
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  async start(outputPath: string, options: RecorderOptions = {}): Promise<void> {
    if (this.capturing) {
      throw new Error('WindowCaptureRecorder is already recording')
    }

    const bitrateKbps = options.bitrateKbps ?? DEFAULT_BITRATE_KBPS
    const fps = options.fps ?? DEFAULT_FPS
    const resolution = options.resolution && options.resolution !== 'native' ? options.resolution : undefined
    const startupTimeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    const source = await resolveCaptureSource(options.sourceHint)

    await mkdir(dirname(outputPath), { recursive: true })

    this.pendingSource = source
    this.hiddenWindow = createHiddenCaptureWindow()
    const win = this.hiddenWindow
    const webContentsId = win.webContents.id

    await loadCaptureRenderer(win)

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const cleanupListeners = (): void => {
        ipcMain.removeListener(CAPTURE_STARTED, onStarted)
        ipcMain.removeListener(CAPTURE_ERROR, onError)
      }

      const startupTimer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanupListeners()
        this.pendingSource = null
        void this.teardownHiddenWindow(win)
        reject(
          new Error(
            `Capture did not start within ${startupTimeout}ms. Source: "${source.name}" (${source.id}). ` +
              'The renderer never reported success or failure — this usually means the hidden capture ' +
              'window itself failed to load, or the previous recording was still tearing down when this one started.'
          )
        )
      }, startupTimeout)

      const onStarted = (event: IpcMainEvent, payload: CaptureStartedPayload): void => {
        if (event.sender.id !== webContentsId || settled) return
        settled = true
        clearTimeout(startupTimer)
        cleanupListeners()
        this.pendingSource = null

        const finalPath = withExtension(outputPath, payload.containerExt)
        this.currentOutputPath = finalPath
        this.writeStream = createWriteStream(finalPath)
        this.writeChain = Promise.resolve()
        this.capturing = true

        this.bindChunkListeners(webContentsId, win)
        // Set AFTER capture is actually confirmed active — RecorderStateMachine reads
        // "now" right after this resolves to compute the pre-roll trim offset.
        resolve()
      }

      const onError = (event: IpcMainEvent, payload: CaptureErrorPayload): void => {
        if (event.sender.id !== webContentsId || settled) return
        settled = true
        clearTimeout(startupTimer)
        cleanupListeners()
        this.pendingSource = null
        void this.teardownHiddenWindow(win)
        reject(new Error(`Capture failed to start: ${payload.message}`))
      }

      ipcMain.on(CAPTURE_STARTED, onStarted)
      ipcMain.on(CAPTURE_ERROR, onError)

      win.webContents.send(CAPTURE_START, { sourceId: source.id, bitrateKbps, fps, resolution })
    })
  }

  // Chunk/finished/error listeners for the lifetime of an active recording.
  // Bound after start() resolves; unbound in stop()/teardown.
  private bindChunkListeners(webContentsId: number, win: BrowserWindow): void {
    const onChunk = (event: IpcMainEvent, buf: ArrayBuffer): void => {
      if (event.sender.id !== webContentsId) return
      this.enqueueWrite(Buffer.from(buf))
    }
    const onUnexpectedError = (event: IpcMainEvent, payload: CaptureErrorPayload): void => {
      if (event.sender.id !== webContentsId || !this.capturing) return
      console.error('[WindowCaptureRecorder] Capture error mid-recording:', payload.message)
      const outputPath = this.currentOutputPath ?? ''
      this.capturing = false
      ipcMain.removeListener(CAPTURE_CHUNK, onChunk)
      ipcMain.removeListener(CAPTURE_ERROR, onUnexpectedError)
      void this.finalizeWriteStream().finally(() => {
        void this.teardownHiddenWindow(win)
        this.emit('unexpectedStop', { code: null, outputPath, stderrTail: [payload.message] })
      })
    }

    this.activeChunkListener = onChunk
    this.activeErrorListener = onUnexpectedError
    ipcMain.on(CAPTURE_CHUNK, onChunk)
    ipcMain.on(CAPTURE_ERROR, onUnexpectedError)
  }

  private activeChunkListener: ((event: IpcMainEvent, buf: ArrayBuffer) => void) | null = null
  private activeErrorListener: ((event: IpcMainEvent, payload: CaptureErrorPayload) => void) | null = null

  // Serializes chunk writes and respects Node stream backpressure — chunks arrive
  // roughly every 1s at 0.5-2MB each; without awaiting 'drain' on a slow disk, writes
  // could queue up unbounded in Node's internal buffer over a 10+ minute session.
  private enqueueWrite(buf: Buffer): void {
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          const stream = this.writeStream
          if (stream === null) {
            resolve()
            return
          }
          const ok = stream.write(buf)
          if (ok) {
            resolve()
          } else {
            stream.once('drain', () => resolve())
          }
        })
    )
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  stop(): Promise<string> {
    if (!this.capturing || this.hiddenWindow === null || this.currentOutputPath === null) {
      return Promise.reject(new Error('WindowCaptureRecorder is not recording'))
    }

    const win = this.hiddenWindow
    const webContentsId = win.webContents.id
    const outputPath = this.currentOutputPath

    // Clear immediately so isRecording() returns false and a second stop() call is
    // rejected before teardown actually completes.
    this.capturing = false

    return new Promise<string>((resolve, reject) => {
      let settled = false

      const finish = (): void => {
        if (settled) return
        settled = true
        if (this.activeChunkListener) ipcMain.removeListener(CAPTURE_CHUNK, this.activeChunkListener)
        if (this.activeErrorListener) ipcMain.removeListener(CAPTURE_ERROR, this.activeErrorListener)
        ipcMain.removeListener(CAPTURE_FINISHED, onFinished)
        this.activeChunkListener = null
        this.activeErrorListener = null

        void this.finalizeWriteStream()
          .then(() => this.teardownHiddenWindow(win))
          .then(() => {
            this.currentOutputPath = null
            resolve(outputPath)
          })
          .catch((err: Error) => reject(err))
      }

      // Fallback: if the renderer never acks (e.g. window already gone), don't hang
      // stop() forever — finalize with whatever was written so far.
      const flushTimer = setTimeout(finish, STOP_FLUSH_TIMEOUT_MS)

      const onFinished = (event: IpcMainEvent): void => {
        if (event.sender.id !== webContentsId) return
        clearTimeout(flushTimer)
        finish()
      }
      ipcMain.on(CAPTURE_FINISHED, onFinished)

      if (win.isDestroyed()) {
        clearTimeout(flushTimer)
        finish()
      } else {
        win.webContents.send(CAPTURE_STOP)
      }
    })
  }

  // Waits for all queued chunk writes to flush, then closes the write stream and
  // awaits its 'close' event — stop() must not resolve until the file is fully on
  // disk, otherwise StorageManager reads a truncated video.
  private async finalizeWriteStream(): Promise<void> {
    await this.writeChain
    const stream = this.writeStream
    this.writeStream = null
    if (stream === null) return
    await new Promise<void>((resolve, reject) => {
      stream.once('close', resolve)
      stream.once('error', reject)
      stream.end()
    })
  }

  // Takes the specific window this start()/stop() call owns, rather than reading the
  // shared this.hiddenWindow field — Solo Shuffle can call stop() for round N and
  // start() for round N+1 close enough together that round N's async teardown would
  // otherwise run after this.hiddenWindow has already been overwritten with round
  // N+1's window, destroying the wrong one (round N+1's capture would then hang until
  // the startup timeout, since its window was destroyed before it could ever send
  // CAPTURE_STARTED).
  private async teardownHiddenWindow(win: BrowserWindow | null): Promise<void> {
    if (this.hiddenWindow === win) this.hiddenWindow = null
    if (win !== null && !win.isDestroyed()) {
      win.destroy()
    }
  }
}

// ---------------------------------------------------------------------------
// Hidden window helpers
// ---------------------------------------------------------------------------

function createHiddenCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    // Never call .show() — "hidden" here means invisible, NOT Electron's `offscreen`
    // rendering mode, which is unrelated to (and incompatible with) real
    // getDisplayMedia capture semantics.
    webPreferences: {
      preload: join(__dirname, '../preload/capture.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // This window is never shown, so Chromium would otherwise apply background
      // throttling to its timers and rendering — which can starve the MediaRecorder
      // encoder and the WebAudio graph that keeps the audio pipeline fed.
      backgroundThrottling: false
    }
  })

  // captureMain.ts's console.warn() diagnostics (mimeType support, audio track presence,
  // etc.) otherwise only reach a hidden window's invisible, inaccessible DevTools — pipe
  // them into the main process's own console/terminal so they're actually observable
  // (and end up in whatever log capture the packaged app has), instead of being lost.
  //
  // Electron's .d.ts declares this event as (event, messageDetails: { message }), but at
  // runtime on this Electron version it's actually invoked positionally as
  // (event, level, message, line, sourceId) — messageDetails.message came back
  // `undefined` every time, confirming the mismatch. Read both shapes defensively.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const messageDetails = args[1] as { message?: string } | undefined
    const positionalMessage = args[2]
    const message =
      typeof messageDetails === 'object' && messageDetails !== null && typeof messageDetails.message === 'string'
        ? messageDetails.message
        : typeof positionalMessage === 'string'
          ? positionalMessage
          : String(messageDetails)
    console.warn(`[capture-renderer] ${message}`)
  })

  return win
}

async function loadCaptureRenderer(win: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture.html`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/capture.html'))
  }
}

function withExtension(outputPath: string, ext: 'mp4' | 'webm'): string {
  return outputPath.replace(/\.[^./\\]+$/, `.${ext}`)
}
