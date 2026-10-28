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
