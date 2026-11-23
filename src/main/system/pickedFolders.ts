// Folders the user chose in the system folder picker during this run, by what they were
// chosen for. The page can only point a path setting somewhere the user actually picked,
// not at any path it names:
//   - the recordings folder is the only place app://depleted/media serves files from
//   - the WoW folder is where the addon gets copied to, and where the combat log is read

import type { FolderPurpose } from '@shared/ipc.types'

// The WoW folder the app assumes until the user picks one (also the onboarding default)
export const DEFAULT_WOW_PATH = '/Applications/World of Warcraft'

const picked: Record<FolderPurpose, Set<string>> = { wow: new Set(), recordings: new Set() }

export function rememberPickedFolder(purpose: FolderPurpose, path: string): void {
  picked[purpose].add(path)
}

export function wasPicked(purpose: FolderPurpose, path: string): boolean {
  return picked[purpose].has(path)
}

// A WoW folder the page may use for anything that writes: the one in the config, the
// default, or one the user picked for WoW in this run
export function isAllowedWowPath(path: string, current: string): boolean {
  return path === current || path === DEFAULT_WOW_PATH || wasPicked('wow', path)
}
