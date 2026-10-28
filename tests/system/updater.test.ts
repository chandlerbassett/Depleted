import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, () => unknown>()
const updaterEvents = new Map<string, (info: { version: string }) => void>()
const quitAndInstall = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: (channel: string, fn: () => unknown) => handlers.set(channel, fn) }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (event: string, fn: (info: { version: string }) => void) => updaterEvents.set(event, fn),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall
  }
}))

const { setupAutoUpdater } = await import('../../src/main/updater')

const fakeWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

beforeEach(() => {
  handlers.clear()
  updaterEvents.clear()
  quitAndInstall.mockClear()
})

describe('setupAutoUpdater', () => {
  it('marks the app as quitting before installing, so minimize-to-tray lets the window close', () => {
    const order: string[] = []
    quitAndInstall.mockImplementation(() => order.push('install'))
    setupAutoUpdater(fakeWindow as never, () => false, () => order.push('quitting'))
    updaterEvents.get('update-downloaded')!({ version: '1.1.1' })

    expect(handlers.get('updater:install')!()).toEqual({ installed: true })
    expect(order).toEqual(['quitting', 'install'])
  })

  it('does not install while recording, or before an update has downloaded', () => {
    const beforeInstall = vi.fn()
    let recording = true
    setupAutoUpdater(fakeWindow as never, () => recording, beforeInstall)

    expect(handlers.get('updater:install')!()).toEqual({ installed: false })
    updaterEvents.get('update-downloaded')!({ version: '1.1.1' })
    expect(handlers.get('updater:install')!()).toEqual({ installed: false })
    recording = false
    expect(handlers.get('updater:install')!()).toEqual({ installed: true })
    expect(beforeInstall).toHaveBeenCalledOnce()
  })
})
