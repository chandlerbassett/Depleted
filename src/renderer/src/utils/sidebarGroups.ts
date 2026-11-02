import type { Clip, Recording } from '@shared/ipc.types'

export interface ClipEntry {
  clip: Clip
  recording: Recording
}

// Newest first
export function allClips(recordings: Recording[]): ClipEntry[] {
  return recordings
    .flatMap((recording) => recording.clips.map((clip) => ({ clip, recording })))
    .sort((a, b) => b.clip.createdAt.localeCompare(a.clip.createdAt))
}
