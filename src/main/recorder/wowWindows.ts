// The WoW client's windows, as the capture helper sees them (`depleted-capture windows`
// lists only windows owned by the WoW app, by bundle id). Settings uses this to offer only
// WoW windows as capture sources: the helper won't record any other window anyway.

import { execFile } from 'child_process'

const LIST_TIMEOUT_MS = 10_000

// The ScreenCaptureKit window ids in the helper's `windows` output
export function parseWowWindowIds(stdout: string): Set<number> {
  const ids = new Set<number>()
  for (const line of stdout.split('\n')) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event !== 'object' || event === null || (event as { event?: unknown }).event !== 'windows') continue
    const windows = (event as { windows?: unknown }).windows
    if (!Array.isArray(windows)) continue
    for (const w of windows) {
      const id = (w as { id?: unknown } | null)?.id
      if (Number.isSafeInteger(id) && (id as number) > 0) ids.add(id as number)
    }
  }
  return ids
}

export function listWowWindowIds(helperPath: string): Promise<Set<number>> {
  return new Promise((resolve, reject) => {
    execFile(helperPath, ['windows'], { timeout: LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(parseWowWindowIds(stdout))
    })
  })
}

// desktopCapturer window ids on macOS are "window:<CGWindowID>:0", and SCWindow.windowID is
// the same CGWindowID
export function desktopCapturerWindowId(sourceId: string): number | null {
  const match = /^window:(\d+):/.exec(sourceId)
  return match === null ? null : Number(match[1])
}
