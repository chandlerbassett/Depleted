import { describe, it, expect, vi, afterEach } from 'vitest'

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))
vi.mock('electron', () => electron)

const { devRendererUrl } = await import('../../src/main/system/devRendererUrl')

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
  electron.app.isPackaged = false
})

describe('devRendererUrl', () => {
  it('uses the dev server in a dev run', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(devRendererUrl()).toBe('http://localhost:5173')
  })

  it('ignores the variable in a packaged app', () => {
    electron.app.isPackaged = true
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:9999'
    expect(devRendererUrl()).toBeUndefined()
  })

  it('is undefined when not set', () => {
    expect(devRendererUrl()).toBeUndefined()
  })
})
