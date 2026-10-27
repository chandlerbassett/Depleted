// FFmpeg binary resolution + macOS Screen Recording permission check.
//
// FFmpeg is only used on Windows, for post-processing (StorageManager: trim + thumbnail).
// macOS does capture and post-processing with the native helper (native/DepletedCapture).

import { execSync } from 'child_process'
import { systemPreferences } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export type ScreenPermissionStatus = 'granted' | 'denied' | 'not-determined' | 'restricted'

// Returns the absolute path to the system FFmpeg binary.
// Throws if FFmpeg is not installed.
//
// Finder-launched apps have a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
// excludes Homebrew. We therefore fall back to the two known Homebrew prefixes
// after `which` fails: /opt/homebrew (Apple Silicon) and /usr/local (Intel).
export function resolveFfmpegPath(): string {
  if (process.platform === 'win32') {
    try {
      const p = execSync('where ffmpeg', { stdio: ['pipe', 'pipe', 'pipe'] })
        .toString()
        .trim()
        .split('\n')[0]
        ?.trim()
      if (p && p.length > 0) return p
    } catch {
      // where failed — try known install locations below.
    }
    const winCandidates = [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      join(process.env.LOCALAPPDATA ?? '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe'
    ]
    for (const candidate of winCandidates) {
      if (existsSync(candidate)) return candidate
    }
    throw new Error('FFmpeg not found. Download from https://ffmpeg.org/download.html and add to PATH.')
  }

  try {
    const p = execSync('which ffmpeg', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (p.length > 0) return p
  } catch {
    // Terminal-launched path lookup failed — try known Homebrew locations below.
  }

  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error('FFmpeg not found. Install via: brew install ffmpeg')
}

// Returns the current Screen Recording permission status.
// 'granted' is required before getDisplayMedia/desktopCapturer will succeed.
export function checkScreenPermission(): ScreenPermissionStatus {
  if (process.platform === 'win32') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen') as ScreenPermissionStatus
}
