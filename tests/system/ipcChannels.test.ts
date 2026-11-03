import { describe, it, expect } from 'vitest'
import { isCommandChannel, isEventChannel } from '../../src/shared/ipcChannels'

describe('IPC channel allowlist (preload)', () => {
  it('lets the app’s own channels through', () => {
    expect(isCommandChannel('config:set')).toBe(true)
    expect(isCommandChannel('storage:saveClip')).toBe(true)
    expect(isEventChannel('recorder:statusChanged')).toBe(true)
  })

  it('refuses anything else, including Electron internals and prototype keys', () => {
    expect(isCommandChannel('ELECTRON_BROWSER_REQUIRE')).toBe(false)
    expect(isCommandChannel('recorder:start')).toBe(false)
    expect(isCommandChannel('__proto__')).toBe(false)
    expect(isCommandChannel('constructor')).toBe(false)
    expect(isCommandChannel(undefined)).toBe(false)
    expect(isCommandChannel({ toString: () => 'config:set' })).toBe(false)
    expect(isEventChannel('config:set')).toBe(false)
    expect(isEventChannel('hasOwnProperty')).toBe(false)
  })
})
