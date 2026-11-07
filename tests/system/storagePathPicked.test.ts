import { describe, it, expect, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, params: unknown) => unknown>()
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: unknown, params: unknown) => unknown) => handlers.set(channel, fn) } }))

const { registerConfigIpc } = await import('../../src/main/ipc/config.ipc')
const { rememberPickedFolder } = await import('../../src/main/system/pickedFolders')
const { DEFAULT_STORAGE_PATH } = await import('../../src/shared/constants')

const values: Record<string, unknown> = { storagePath: '/Users/me/Recordings' }
const store = { get: (key: string) => values[key], set: (key: string, value: unknown) => (values[key] = value) }
registerConfigIpc(store as never)
const set = (key: string, value: unknown): unknown => handlers.get('config:set')!(null, { key, value })

describe('config:set storagePath', () => {
  it('refuses a folder the user did not pick', () => {
    expect(() => set('storagePath', '/Users/me')).toThrow('folder picker')
    expect(values.storagePath).toBe('/Users/me/Recordings')
  })

  it('takes a picked folder, the current one and the default', () => {
    rememberPickedFolder('/Volumes/External/Depleted')
    set('storagePath', '/Volumes/External/Depleted')
    expect(values.storagePath).toBe('/Volumes/External/Depleted')
    set('storagePath', '/Volumes/External/Depleted')
    set('storagePath', DEFAULT_STORAGE_PATH)
    expect(values.storagePath).toBe(DEFAULT_STORAGE_PATH)
  })

  it('leaves other paths alone', () => {
    set('wowPath', '/Applications/World of Warcraft')
    expect(values.wowPath).toBe('/Applications/World of Warcraft')
  })
})
