import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAddonInfoStale, isAddonVersionOutdated, type AddonCharacterInfo } from '../../src/main/addon/SavedVarsReader'

function makeInfo(overrides: Partial<AddonCharacterInfo> = {}): AddonCharacterInfo {
  return {
    guid: 'Player-1329-0A8F36D7',
    name: 'Sachi',
    realm: 'Thrall',
    fullName: 'Sachi-Thrall',
    class: 'Mage',
    spec: 'Fire',
    updated: new Date().toISOString(),
    version: '2.0.0',
    ...overrides
  }
}

describe('isAddonInfoStale', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not stale right after the addon updates it', () => {
    expect(isAddonInfoStale(makeInfo({ updated: new Date().toISOString() }))).toBe(false)
  })

  it('is stale when updated 3 days ago (quit the game and never reloaded)', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(isAddonInfoStale(makeInfo({ updated: threeDaysAgo }))).toBe(true)
  })

  it('is stale when the addon never wrote an updated timestamp (pre-1.2.0 install)', () => {
    expect(isAddonInfoStale(makeInfo({ updated: null }))).toBe(true)
  })

  it('is stale when the timestamp fails to parse', () => {
    expect(isAddonInfoStale(makeInfo({ updated: 'not-a-date' }))).toBe(true)
  })
})

describe('isAddonVersionOutdated', () => {
  it('is not outdated when the version matches MIN_ADDON_VERSION', () => {
    expect(isAddonVersionOutdated(makeInfo({ version: '2.0.0' }))).toBe(false)
  })

  it('is not outdated when the version is newer', () => {
    expect(isAddonVersionOutdated(makeInfo({ version: '2.1.0' }))).toBe(false)
  })

  it('is outdated when the version is older (e.g. the original ArenaRecorderCompanion 1.2.0)', () => {
    expect(isAddonVersionOutdated(makeInfo({ version: '1.2.0' }))).toBe(true)
  })

  it('is outdated when there is no version at all (pre-1.2.0 install)', () => {
    expect(isAddonVersionOutdated(makeInfo({ version: null }))).toBe(true)
  })
})
