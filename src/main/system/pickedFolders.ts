// Folders the user chose in the system folder picker during this run. The recordings
// folder is the only place app://depleted/media serves files from, so the page can only
// move it to a folder the user actually picked, not to any path it names.

const picked = new Set<string>()

export function rememberPickedFolder(path: string): void {
  picked.add(path)
}

export function wasPicked(path: string): boolean {
  return picked.has(path)
}
