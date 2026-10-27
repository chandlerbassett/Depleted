// Runs the depleted-capture helper (native/DepletedCapture), which does capture,
// trimming and thumbnails on macOS. It reports one JSON event per stdout line.
// Its location is resolved in nativeHelperPath.ts (kept apart so this file has no
// electron import and stays testable).

import { spawn } from 'child_process'
import { existsSync } from 'fs'

export const NATIVE_HELPER_NAME = 'depleted-capture'

export interface HelperEvent {
  event: string
  message?: string
  path?: string
  [key: string]: unknown
}

export function missingHelperMessage(path: string): string {
  return `The capture helper is missing (${path}). Run "npm run build:native" and restart Depleted.`
}

// Splits a stream into lines and parses each as a helper event; non-JSON lines are ignored.
export function createEventParser(onEvent: (e: HelperEvent) => void): (chunk: Buffer) => void {
  let buffered = ''
  return (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let nl: number
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line) as HelperEvent
        if (typeof parsed.event === 'string') onEvent(parsed)
      } catch {
        // not one of ours
      }
    }
  }
}

// Runs a one-shot helper command (trim, thumbnail) and resolves on its `done` event.
export function runHelperCommand(helperPath: string, args: string[]): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    if (!existsSync(helperPath)) {
      reject(new Error(missingHelperMessage(helperPath)))
      return
    }
    const proc = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let done: HelperEvent | null = null
    let error: string | null = null
    const stderrTail: string[] = []

    proc.stdout.on(
      'data',
      createEventParser((e) => {
        if (e.event === 'done') done = e
        if (e.event === 'error') error = e.message ?? 'unknown error'
      })
    )
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString())
      if (stderrTail.length > 10) stderrTail.shift()
    })
    proc.on('error', (err) => reject(new Error(`${NATIVE_HELPER_NAME} failed to run: ${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0 && done !== null) {
        resolve(done)
      } else {
        const detail = error ?? (stderrTail.join('').trim() || `exit code ${code}`)
        reject(new Error(`${NATIVE_HELPER_NAME} ${args[0]} failed: ${detail}`))
      }
    })
  })
}
