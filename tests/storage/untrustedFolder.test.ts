import { describe, it, expect } from 'vitest'
import { isUsableMetadata } from '../../src/main/storage/MetadataWriter'
import { toWclFightLink } from '../../src/main/storage/StorageManager'

const good = { date: '2026-11-23T17:00:00.000Z', zone: 'Ruby Life Pools', duration: 1800, videoExt: 'mp4', events: [] }

describe('isUsableMetadata', () => {
  it('takes what the app writes', () => {
    expect(isUsableMetadata(good)).toBe(true)
    const { videoExt: _, ...old } = good
    expect(isUsableMetadata(old)).toBe(true)
  })

  it('refuses a videoExt that could add to a path', () => {
    expect(isUsableMetadata({ ...good, videoExt: 'x/../../evil' })).toBe(false)
    expect(isUsableMetadata({ ...good, videoExt: 'mov' })).toBe(false)
  })

  it('refuses a date, duration or events of the wrong kind', () => {
    expect(isUsableMetadata({ ...good, date: 42 })).toBe(false)
    expect(isUsableMetadata({ ...good, date: 'not a date' })).toBe(false)
    expect(isUsableMetadata({ ...good, duration: Infinity })).toBe(false)
    expect(isUsableMetadata({ ...good, events: {} })).toBe(false)
    expect(isUsableMetadata(null)).toBe(false)
  })
})

describe('toWclFightLink', () => {
  const link = { reportCode: 'aBc123', reportTitle: 'Keys', fightId: 7, url: 'https://evil.example/', parses: [], fetchedAt: '' }

  it('rebuilds the URL from the report code and fight id', () => {
    expect(toWclFightLink(link)?.url).toBe('https://www.warcraftlogs.com/reports/aBc123#fight=7')
  })

  it('refuses a report code or fight id that is not one', () => {
    expect(toWclFightLink({ ...link, reportCode: '../x' })).toBeNull()
    expect(toWclFightLink({ ...link, fightId: '7' })).toBeNull()
  })
})
