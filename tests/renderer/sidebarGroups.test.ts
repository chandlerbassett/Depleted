import { describe, it, expect } from 'vitest'
import { groupRaidNights, allClips } from '../../src/renderer/src/utils/sidebarGroups'
import type { Clip, RaidInfo, Recording } from '../../src/shared/ipc.types'

function pull(id: string, date: string, raid: Partial<RaidInfo>, clips: Clip[] = []): Recording {
  return {
    id,
    path: '',
    videoPath: '',
    thumbnailPath: '',
    clips,
    metadata: {
      date,
      zone: 'Manaforge Omega',
      bracket: 'raid',
      result: raid.outcome === 'kill' ? 'WIN' : 'LOSS',
      duration: 300,
      playerName: '',
      playerClass: '',
      playerSpec: '',
      teamComp: [],
      knownSpecs: {},
      events: [],
      raid: {
        instanceId: 2810,
        encounterId: 1,
        encounterName: 'Boss One',
        difficulty: 'heroic',
        groupSize: 20,
        outcome: 'wipe',
        fightTimeMs: 0,
        pullNumber: 1,
        deathCount: 0,
        deathsByPlayer: {},
        interruptsByPlayer: {},
        ...raid
      }
    }
  }
}

describe('groupRaidNights', () => {
  it('groups a night past midnight by boss, newest night first', () => {
    const recs = [
      pull('a', '2026-11-01T20:00:00Z', {}),
      pull('b', '2026-11-01T20:10:00Z', { outcome: 'kill' }),
      pull('c', '2026-11-01T23:50:00Z', { encounterId: 2, encounterName: 'Boss Two' }),
      pull('d', '2026-11-02T00:20:00Z', { encounterId: 2, encounterName: 'Boss Two', difficulty: 'mythic' }),
      pull('e', '2026-11-03T20:00:00Z', {})
    ]
    const nights = groupRaidNights(recs)

    expect(nights.map((n) => n.id)).toEqual(['e', 'a'])
    const night = nights[1]!
    expect(night.pullCount).toBe(4)
    expect(night.killCount).toBe(1)
    expect(night.difficulties).toEqual(['heroic', 'mythic'])
    expect(night.bosses.map((b) => [b.name, b.pulls.map((p) => p.id), b.killed])).toEqual([
      ['Boss One', ['a', 'b'], true],
      ['Boss Two', ['c', 'd'], false]
    ])
  })

  it('starts a new night in a different raid', () => {
    const recs = [pull('a', '2026-11-01T20:00:00Z', {}), pull('b', '2026-11-01T21:00:00Z', { instanceId: 2900 })]
    expect(groupRaidNights(recs)).toHaveLength(2)
  })
})

describe('allClips', () => {
  it('lists every clip newest first with its recording', () => {
    const clip = (id: string, createdAt: string): Clip => ({
      id, recordingId: '', fileName: '', videoPath: '', thumbnailPath: null, start: 0, end: 10, createdAt
    })
    const recs = [
      pull('a', '2026-11-01T20:00:00Z', {}, [clip('a/1', '2026-11-01T21:00:00Z')]),
      pull('b', '2026-11-01T20:10:00Z', {}, [clip('b/1', '2026-11-02T09:00:00Z'), clip('b/2', '2026-11-01T22:00:00Z')])
    ]
    expect(allClips(recs).map((c) => [c.clip.id, c.recording.id])).toEqual([
      ['b/1', 'b'],
      ['b/2', 'b'],
      ['a/1', 'a']
    ])
  })
})
