import { describe, it, expect, vi, afterEach } from 'vitest'

const electron = vi.hoisted(() => {
  const switches = new Set<string>()
  return {
    switches,
    app: { isPackaged: true, commandLine: { hasSwitch: (name: string) => switches.has(name) } }
  }
})
vi.mock('electron', () => ({ app: electron.app }))

const { forbiddenDebugSwitch } = await import('../../src/main/system/debugSwitches')

afterEach(() => {
  electron.switches.clear()
  electron.app.isPackaged = true
})

describe('forbiddenDebugSwitch', () => {
  it('flags --remote-debugging-port and --remote-debugging-pipe in a release', () => {
    electron.switches.add('remote-debugging-port')
    expect(forbiddenDebugSwitch()).toBe('remote-debugging-port')
    electron.switches.clear()
    electron.switches.add('remote-debugging-pipe')
    expect(forbiddenDebugSwitch()).toBe('remote-debugging-pipe')
  })

  it('allows a release started without them', () => {
    electron.switches.add('enable-features')
    expect(forbiddenDebugSwitch()).toBeUndefined()
  })

  it('allows them in a dev run', () => {
    electron.app.isPackaged = false
    electron.switches.add('remote-debugging-port')
    expect(forbiddenDebugSwitch()).toBeUndefined()
  })
})
