import { describe, it, expect, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, params: unknown) => unknown>()
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: (channel: string, fn: (event: unknown, params: unknown) => unknown) => handlers.set(channel, fn) } }))

const { registerConfigIpc } = await import('../../src/main/ipc/config.ipc')
const { rememberPickedFolder } = await import('../../src/main/system/pickedFolders')
const { appPageEvent } = await import('../helpers/ipcEvent')
const { DEFAULT_STORAGE_PATH } = await import('../../src/shared/constants')

const values: Record<string, unknown> = { storagePath: '/Users/me/Recordings' }
const store = { get: (key: string) => values[key], set: (key: string, value: unknown) => (values[key] = value) }
registerConfigIpc(store as never)
const set = (key: string, value: unknown): unknown => handlers.get('config:set')!(appPageEvent, { key, value })

describe('config:set storagePath', () => {
  it('refuses a folder the user did not pick', () => {
    expect(() => set('storagePath', '/Users/me')).toThrow('folder picker')
    expect(values.storagePath).toBe('/Users/me/Recordings')
  })

  it('takes a picked folder, the current one and the default', () => {
    rememberPickedFolder('recordings', '/Volumes/External/Depleted')
    set('storagePath', '/Volumes/External/Depleted')
    expect(values.storagePath).toBe('/Volumes/External/Depleted')
    set('storagePath', '/Volumes/External/Depleted')
    set('storagePath', DEFAULT_STORAGE_PATH)
    expect(values.storagePath).toBe(DEFAULT_STORAGE_PATH)
  })

  it('does not count a folder picked for WoW', () => {
    rememberPickedFolder('wow', '/Users/me/Games/World of Warcraft')
    expect(() => set('storagePath', '/Users/me/Games/World of Warcraft')).toThrow('folder picker')
  })
})

describe('config:set wowPath', () => {
  it('refuses a folder the user did not pick', () => {
    values.wowPath = '/Applications/World of Warcraft'
    expect(() => set('wowPath', '/Users/me/Library/LaunchAgents')).toThrow('folder picker')
    expect(values.wowPath).toBe('/Applications/World of Warcraft')
  })

  it('takes a folder picked for WoW, the current one and the default', () => {
    rememberPickedFolder('wow', '/Volumes/Games/World of Warcraft')
    set('wowPath', '/Volumes/Games/World of Warcraft')
    expect(values.wowPath).toBe('/Volumes/Games/World of Warcraft')
    set('wowPath', '/Volumes/Games/World of Warcraft')
    set('wowPath', '/Applications/World of Warcraft')
    expect(values.wowPath).toBe('/Applications/World of Warcraft')
  })

  it('does not count a folder picked for recordings', () => {
    rememberPickedFolder('recordings', '/Users/me/Movies/Depleted')
    expect(() => set('wowPath', '/Users/me/Movies/Depleted')).toThrow('folder picker')
  })
})

describe('config:set from another page', () => {
  it('is refused before the value is looked at', () => {
    const before = values.storagePath
    const fromFrame = (senderFrame: unknown): unknown => handlers.get('config:set')!({ sender: {}, senderFrame }, { key: 'storagePath', value: DEFAULT_STORAGE_PATH })
    expect(() => fromFrame({ origin: 'https://evil.example', parent: null })).toThrow('Refused')
    expect(() => fromFrame({ origin: 'app://depleted', parent: {} })).toThrow('Refused')
    expect(() => fromFrame(null)).toThrow('Refused')
    expect(values.storagePath).toBe(before)
  })
})
