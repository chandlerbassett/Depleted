import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { isConfigKey } = await import('../../src/main/ipc/config.ipc')

describe('isConfigKey', () => {
  it('accepts the settings the app has', () => {
    expect(isConfigKey('storagePath')).toBe(true)
    expect(isConfigKey('onboardingComplete')).toBe(true)
  })

  it('refuses anything else, including dotted paths and prototype keys', () => {
    expect(isConfigKey('storagePath.x')).toBe(false)
    expect(isConfigKey('__proto__')).toBe(false)
    expect(isConfigKey('toString')).toBe(false)
    expect(isConfigKey(42)).toBe(false)
  })
})

const { isValidConfigValue } = await import('../../src/main/ipc/config.ipc')

describe('isValidConfigValue', () => {
  it('takes the values Settings and onboarding write', () => {
    expect(isValidConfigValue('wowPath', '/Applications/World of Warcraft')).toBe(true)
    expect(isValidConfigValue('storagePath', '/Users/me/Movies/Depleted')).toBe(true)
    expect(isValidConfigValue('videoBitrate', 80000)).toBe(true)
    expect(isValidConfigValue('videoFps', 60)).toBe(true)
    expect(isValidConfigValue('videoCodec', 'hevc')).toBe(true)
    expect(isValidConfigValue('captureSourceHint', 'auto')).toBe(true)
    expect(isValidConfigValue('captureSourceHint', 'World of Warcraft')).toBe(true)
    expect(isValidConfigValue('videoResolution', 'native')).toBe(true)
    expect(isValidConfigValue('videoResolution', '3840x2160')).toBe(true)
    expect(isValidConfigValue('autoCleanupDays', null)).toBe(true)
    expect(isValidConfigValue('autoCleanupMaxGb', 50)).toBe(true)
    expect(isValidConfigValue('minimizeToTray', false)).toBe(true)
    expect(isValidConfigValue('statsSite', 'warcraftlogs')).toBe(true)
    expect(isValidConfigValue('wowRegion', 'us')).toBe(true)
    expect(isValidConfigValue('raidDifficulties', ['heroic', 'mythic'])).toBe(true)
    expect(isValidConfigValue('raidDifficulties', [])).toBe(true)
    expect(isValidConfigValue('bufferWhileGameOpen', true)).toBe(true)
  })

  it('refuses the wrong type, relative paths and values outside the app’s options', () => {
    expect(isValidConfigValue('wowPath', 'World of Warcraft')).toBe(false)
    expect(isValidConfigValue('wowPath', '')).toBe(false)
    expect(isValidConfigValue('storagePath', 42)).toBe(false)
    expect(isValidConfigValue('storagePath', '/tmp/x\0y')).toBe(false)
    expect(isValidConfigValue('videoBitrate', '80000')).toBe(false)
    expect(isValidConfigValue('videoBitrate', 1e9)).toBe(false)
    expect(isValidConfigValue('videoBitrate', 1000.5)).toBe(false)
    expect(isValidConfigValue('videoFps', 120)).toBe(false)
    expect(isValidConfigValue('videoCodec', 'av1')).toBe(false)
    expect(isValidConfigValue('videoResolution', '--window')).toBe(false)
    expect(isValidConfigValue('videoResolution', '0x0')).toBe(false)
    expect(isValidConfigValue('captureSourceHint', 'x'.repeat(2000))).toBe(false)
    expect(isValidConfigValue('autoCleanupDays', -1)).toBe(false)
    expect(isValidConfigValue('autoCleanupDays', NaN)).toBe(false)
    expect(isValidConfigValue('minimizeToTray', 'true')).toBe(false)
    expect(isValidConfigValue('statsSite', 'check-pvp')).toBe(false)
    expect(isValidConfigValue('wowRegion', 'EU')).toBe(false)
    expect(isValidConfigValue('raidDifficulties', ['heroic', 'heroic'])).toBe(false)
    expect(isValidConfigValue('raidDifficulties', 'heroic')).toBe(false)
    expect(isValidConfigValue('raidDifficulties', [{ toString: () => 'mythic' }])).toBe(false)
    expect(isValidConfigValue('bufferWhileGameOpen', null)).toBe(false)
  })
})
