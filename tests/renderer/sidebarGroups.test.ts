import { describe, it, expect } from 'vitest'
import { allClips } from '../../src/renderer/src/utils/sidebarGroups'
import type { Clip, Recording } from '../../src/shared/ipc.types'

// allClips only looks at ids and clips
function key(id: string, clips: Clip[]): Recording {
  return { id, clips } as unknown as Recording
}

describe('allClips', () => {
  it('lists every clip newest first with its recording', () => {
    const clip = (id: string, createdAt: string): Clip => ({
      id, recordingId: '', fileName: '', videoPath: '', thumbnailPath: null, start: 0, end: 10, createdAt
    })
    const recs = [
      key('a', [clip('a/1', '2026-11-01T21:00:00Z')]),
      key('b', [clip('b/1', '2026-11-02T09:00:00Z'), clip('b/2', '2026-11-01T22:00:00Z')])
    ]
    expect(allClips(recs).map((c) => [c.clip.id, c.recording.id])).toEqual([
      ['b/1', 'b'],
      ['b/2', 'b'],
      ['a/1', 'a']
    ])
  })
})
