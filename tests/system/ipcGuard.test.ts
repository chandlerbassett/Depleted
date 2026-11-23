import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    app: { isPackaged: true },
    ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) }
  }
})
vi.mock('electron', () => electron)

const { handle, isTrustedFrame, isTrustedSender, trustedOrigins } = await import('../../src/main/system/ipcGuard')

const top = (origin: string): { origin: string; parent: null } => ({ origin, parent: null })

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
  electron.app.isPackaged = true
  electron.handlers.clear()
})

describe('isTrustedFrame', () => {
  it("takes the top frame of the app's own page", () => {
    expect(isTrustedFrame(top('app://depleted'))).toBe(true)
  })

  it('refuses any other origin', () => {
    expect(isTrustedFrame(top('https://evil.example'))).toBe(false)
    expect(isTrustedFrame(top('app://other'))).toBe(false)
    expect(isTrustedFrame(top('file://'))).toBe(false)
    expect(isTrustedFrame(top('null'))).toBe(false)
    expect(isTrustedFrame(top('http://localhost:5173'))).toBe(false)
  })

  it('refuses a subframe, even one that inherits the app origin (srcdoc, about:blank)', () => {
    expect(isTrustedFrame({ origin: 'app://depleted', parent: top('app://depleted') })).toBe(false)
  })

  it('refuses a frame that is gone', () => {
    expect(isTrustedFrame(null)).toBe(false)
    expect(isTrustedFrame(undefined)).toBe(false)
  })
})

describe('trustedOrigins', () => {
  it('is only the app origin in a packaged app, whatever the environment says', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:9999'
    expect(trustedOrigins()).toEqual(['app://depleted'])
  })

  it('adds the dev server origin in a dev run', () => {
    electron.app.isPackaged = false
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    expect(trustedOrigins()).toEqual(['app://depleted', 'http://localhost:5173'])
  })
})

describe('isTrustedSender', () => {
  it('refuses when reading senderFrame throws (frame being torn down)', () => {
    const event = {
      get senderFrame(): never {
        throw new Error('Render frame was disposed')
      }
    }
    expect(isTrustedSender(event as never)).toBe(false)
  })
})

describe('handle', () => {
  it('runs the handler for the app page and refuses anything else without running it', async () => {
    const fn = vi.fn((_event: unknown, x: number) => x * 2)
    handle('test:double', fn)
    const registered = electron.handlers.get('test:double')!
    expect(registered({ senderFrame: top('app://depleted') }, 21)).toBe(42)
    expect(() => registered({ senderFrame: top('https://evil.example') }, 1)).toThrow('Refused')
    expect(() => registered({ senderFrame: { origin: 'app://depleted', parent: {} } }, 1)).toThrow('Refused')
    expect(() => registered({ senderFrame: null }, 1)).toThrow('Refused')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// Every handler has to go through the guard: no other main-process file may register
// with ipcMain directly
describe('main process', () => {
  const root = join(__dirname, '../../src/main')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
    })

  it('registers IPC only through ipcGuard', () => {
    const offenders: string[] = []
    for (const file of files(root)) {
      const rel = relative(root, file)
      if (rel === join('system', 'ipcGuard.ts')) continue
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      if (/ipcMain\s*\.\s*(handle|handleOnce|on|once|addListener)\s*\(/.test(code)) {
        // WindowCaptureRecorder listens with ipcMain.on but checks isTrustedSender itself
        if (rel === join('recorder', 'WindowCaptureRecorder.ts') && /isTrustedSender\(event\)/.test(code)) continue
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
