// What the state machines need from a recorder. Two implementations:
//   NativeCaptureRecorder  — macOS: the depleted-capture helper (ScreenCaptureKit + hardware encode)
//   WindowCaptureRecorder  — elsewhere: Chromium getDisplayMedia + MediaRecorder

import type { VideoCodec } from '@shared/ipc.types'

export interface RecorderOptions {
  // Persisted capture-source name (window title), or 'auto'/undefined for WoW-window
  // auto-detect. Window ids aren't stable across restarts, so we resolve by name each time.
  sourceHint?: string
  bitrateKbps?: number
  fps?: number
  // Native capture only; the MediaRecorder path always records VP8/WebM.
  codec?: VideoCodec
  resolution?: string
  startupTimeoutMs?: number
}

export interface RecorderEventMap {
  unexpectedStop: { code: number | null; outputPath: string; stderrTail: string[] }
  // The rolling buffer ended without being asked to (the game quit, capture failed)
  bufferStopped: { message: string }
}

export interface CaptureRecorder {
  // Resolves once capture is confirmed running, with when the file's first frame was
  // captured if the recorder knows (it's before now when the file opens with buffered
  // footage). Without a date the caller reads "now" right after this for the trim offset.
  start(outputPath: string, options?: RecorderOptions): Promise<Date | void>
  // Resolves with the final file path once it's fully written.
  stop(): Promise<string>
  isRecording(): boolean
  // Optional rolling pre-roll buffer (native capture only). While it runs, start() opens
  // a file with up to bufferSecs of footage from before the call.
  startBuffer?(bufferDir: string, bufferSecs: number, options?: RecorderOptions): Promise<void>
  stopBuffer?(): Promise<void>
  isBuffering?(): boolean
  on<K extends keyof RecorderEventMap>(event: K, listener: (payload: RecorderEventMap[K]) => void): this
}
