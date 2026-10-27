// Compares the addon actually sitting in the WoW AddOns folder against the copy bundled
// with this build of the app, by reading each side's .toc `## Version:` line directly —
// independent of SavedVariables, which only reflects the addon's version once the player
// has actually logged in and let it run (see SavedVarsReader.isAddonVersionOutdated for
// that runtime signal). This one works even if WoW was never launched this session, so
// it's meant to run as a background check on every app startup.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ADDON_NAME, ADDON_RELATIVE_PATH } from '@shared/constants'

const TOC_FILENAME = `${ADDON_NAME}.toc`

function extractTocVersion(tocPath: string): string | null {
  if (!existsSync(tocPath)) return null
  try {
    const content = readFileSync(tocPath, 'utf-8')
    const match = /^##\s*Version:\s*(.+)$/m.exec(content)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

export function getInstalledAddonVersion(wowPath: string): string | null {
  return extractTocVersion(join(wowPath, ADDON_RELATIVE_PATH, TOC_FILENAME))
}

export function getBundledAddonVersion(bundledAddonDir: string): string | null {
  return extractTocVersion(join(bundledAddonDir, ADDON_NAME, TOC_FILENAME))
}

export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// True when the addon isn't installed at all, or the installed .toc version is older
// than the bundled one. A bundled version that fails to read is treated as "can't tell" —
// never prompt an update we can't actually confirm is newer.
export function isInstalledAddonOutdated(wowPath: string, bundledAddonDir: string): boolean {
  const bundled = getBundledAddonVersion(bundledAddonDir)
  if (bundled === null) return false
  const installed = getInstalledAddonVersion(wowPath)
  if (installed === null) return false
  return compareVersions(installed, bundled) < 0
}
