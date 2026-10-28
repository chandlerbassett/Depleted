// Test Mode — lets the user record a short (10s) clip of the capture source on demand,
// to verify the capture pipeline actually works before relying on it for a real key.
// Reuses the recorder instance the main pipeline uses, so a test can't overlap a real
// recording (and WindowCaptureRecorder's display-media handler is registered only once).
//
// Commands (ipcMain.handle):
//   testMode:start    — records for TEST_RECORDING_SECS, resolves once stopped
//   testMode:cleanup  — deletes the last test recording's file + containing directory
//
// Push events (webContents.send):
//   testMode:countdown — fired once per second while recording, counting down to 0

import { ipcMain, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { CaptureRecorder } from '../recorder/CaptureRecorder'
import type { MythicPlusStateMachine } from '../recorder/MythicPlusStateMachine'
import type Store from 'electron-store'
import type { AppConfig } from '@shared/ipc.types'

const TEST_RECORDING_SECS = 10

export function registerTestModeIpc(
  recorder: CaptureRecorder,
  stateMachine: MythicPlusStateMachine,
  configStore: Store<AppConfig>,
  storagePath: string
): void {
  let lastTestPath: string | null = null

  ipcMain.handle('testMode:start', async () => {
    await stateMachine.releaseArmedRecorder()
    if (stateMachine.getStatus() !== 'idle' || recorder.isRecording()) {
      return { success: false, error: 'Cannot start a test recording while a key is being recorded.' }
    }

    const testDir = join(storagePath, 'test', `test_${Date.now()}`)
    const outputPath = join(testDir, 'test.mp4')

    try {
      await recorder.start(outputPath, {
        bitrateKbps: configStore.get('videoBitrate'),
        fps: configStore.get('videoFps'),
        codec: configStore.get('videoCodec'),
        sourceHint: configStore.get('captureSourceHint'),
        resolution: configStore.get('videoResolution')
      })
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    lastTestPath = testDir

    for (let remaining = TEST_RECORDING_SECS; remaining > 0; remaining--) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('testMode:countdown', { secondsRemaining: remaining })
      }
      await sleep(1000)
    }

    let videoPath: string
    try {
      videoPath = await recorder.stop()
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    return { success: true, videoPath }
  })

  ipcMain.handle('testMode:cleanup', async () => {
    if (lastTestPath === null) return
    await fs.rm(lastTestPath, { recursive: true, force: true })
    lastTestPath = null
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
