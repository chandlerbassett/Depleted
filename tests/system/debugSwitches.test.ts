import { describe, it, expect, vi, afterEach } from 'vitest'

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }))
vi.mock('electron', () => ({ app: electron.app }))

const { forbiddenSwitch } = await import('../../src/main/system/debugSwitches')

const exe = '/Applications/Depleted.app/Contents/MacOS/Depleted'

afterEach(() => {
  electron.app.isPackaged = true
})

describe('forbiddenSwitch', () => {
  it('refuses the DevTools and launcher switches in a release', () => {
    for (const arg of [
      '--remote-debugging-port=9222',
      '--remote-debugging-pipe',
      '--gpu-launcher=/tmp/evil',
      '--renderer-cmd-prefix=/tmp/evil',
      '--utility-cmd-prefix=/tmp/evil',
      '--host-rules=MAP * 127.0.0.1',
      '--ignore-certificate-errors',
      '-remote-debugging-port=9222'
    ]) {
      expect(forbiddenSwitch([exe, arg])).toBe(arg)
    }
  })

  it('refuses a switch after other arguments too', () => {
    expect(forbiddenSwitch([exe, 'something', '--gpu-launcher=x'])).toBe('--gpu-launcher=x')
  })

  it('allows a release started the normal way', () => {
    expect(forbiddenSwitch([exe])).toBeUndefined()
    expect(forbiddenSwitch([exe, '-psn_0_12345'])).toBeUndefined()
  })

  it('allows switches in a dev run', () => {
    electron.app.isPackaged = false
    expect(forbiddenSwitch([exe, '--remote-debugging-port=9222'])).toBeUndefined()
  })
})
