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
  // Rolling buffer (recorders with keep() only): hold just the last this-many seconds
  // until keep() is called; stopping before that saves nothing
  bufferSecs?: number
}

export interface RecorderEventMap {
  unexpectedStop: { code: number | null; outputPath: string; stderrTail: string[] }
}

export interface CaptureRecorder {
  // Resolves once capture is confirmed running; the state machines read "now" right
  // after this to compute the trim offset.
  start(outputPath: string, options?: RecorderOptions): Promise<void>
  // Resolves with the final file path once it's fully written.
  stop(): Promise<string>
  // Only recorders with a rolling buffer. Makes the buffer the start of the file and
  // records on; resolves with how many seconds before the call the file starts.
  keep?(): Promise<number>
  isRecording(): boolean
  on<K extends keyof RecorderEventMap>(event: K, listener: (payload: RecorderEventMap[K]) => void): this
}
