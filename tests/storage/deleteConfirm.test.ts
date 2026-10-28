import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (event: unknown, params: { id: string }) => unknown>()
const showMessageBox = vi.fn()
const trashItem = vi.fn(async () => undefined)

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox },
  ipcMain: { handle: (channel: string, fn: (event: unknown, params: { id: string }) => unknown) => handlers.set(channel, fn) },
  shell: { trashItem }
}))

const { registerStorageIpc, describeRun } = await import('../../src/main/ipc/storage.ipc')

const recording = {
  id: 'run-1',
  path: '/movies/run-1',
  metadata: { zone: 'Ruby Life Pools', date: '2026-10-27T18:00:00Z', mythicPlus: { keystoneLevel: 15 } }
}
const storageManager = {
  getRecordings: vi.fn(async () => [recording]),
  deleteRecording: vi.fn(async (id: string, remove: (dirPath: string) => Promise<void>) => remove(`/movies/${id}`))
}

beforeEach(() => {
  handlers.clear()
  showMessageBox.mockReset()
  trashItem.mockClear()
  storageManager.deleteRecording.mockClear()
  registerStorageIpc(storageManager as never)
})

const del = (id = 'run-1'): unknown => handlers.get('storage:deleteRecording')?.({ sender: {} }, { id })

describe('storage:deleteRecording', () => {
  it('keeps the run when the user cancels', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await del()).toEqual({ deleted: false })
    expect(storageManager.deleteRecording).not.toHaveBeenCalled()
  })

  it('makes Cancel the default button, so Return does not delete', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    await del()
    const options = showMessageBox.mock.calls[0][0]
    expect(options.buttons[options.defaultId]).toBe('Cancel')
    expect(options.cancelId).toBe(options.defaultId)
    expect(options.detail).toContain('Ruby Life Pools +15')
  })

  it('moves the run to the Trash once confirmed', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    expect(await del()).toEqual({ deleted: true })
    expect(trashItem).toHaveBeenCalledWith('/movies/run-1')
  })

  it('never offers to delete a folder that is not a run in the library', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    expect(await del('Documents')).toEqual({ deleted: false })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(storageManager.deleteRecording).not.toHaveBeenCalled()
  })
})

describe('describeRun', () => {
  it('leaves out the level when it is unknown', () => {
    const r = { ...recording, metadata: { ...recording.metadata, mythicPlus: { keystoneLevel: 0 } } }
    expect(describeRun(r as never)).toBe('Ruby Life Pools from Oct 27, 2026')
  })
})
