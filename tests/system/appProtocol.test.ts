import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))

const { handleAppRequest, parseRange } = await import('../../src/main/system/appProtocol')
const { toMediaUrl } = await import('../../src/shared/appUrl')

let base: string
let uiRoot: string
let mediaRoot: string
let outside: string

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'depleted-proto-')))
  uiRoot = join(base, 'renderer')
  mediaRoot = join(base, 'My Recordings')
  outside = join(base, 'outside')
  mkdirSync(join(uiRoot, 'assets'), { recursive: true })
  mkdirSync(join(mediaRoot, 'run #1'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html>')
  writeFileSync(join(uiRoot, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(uiRoot, 'secret.txt'), 'no')
  writeFileSync(join(mediaRoot, 'run #1', 'recording.mp4'), Buffer.from('0123456789'))
  writeFileSync(join(mediaRoot, 'run #1', 'thumbnail.jpg'), 'jpg')
  writeFileSync(join(mediaRoot, 'run #1', 'metadata.json'), '{}')
  writeFileSync(join(outside, 'private.mp4'), 'private')
  writeFileSync(join(outside, 'private.txt'), 'private')
  symlinkSync(join(outside, 'private.mp4'), join(mediaRoot, 'run #1', 'link.mp4'))
  symlinkSync(join(mediaRoot, 'run #1', 'metadata.json'), join(mediaRoot, 'run #1', 'meta.jpg'))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const roots = (): { uiRoot: string; mediaRoot: string } => ({ uiRoot, mediaRoot })
const get = (url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
  handleAppRequest(new Request(url, { method, headers }), roots())

describe('app:// UI', () => {
  it('serves index.html at the root and assets by path', async () => {
    const index = await get('app://depleted/')
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await get('app://depleted/assets/app.js')).headers.get('content-security-policy')).toBeNull()
    expect(await (await get('app://depleted/assets/app.js')).text()).toBe('console.log(1)')
  })

  it('refuses unknown file types, other hosts and other methods', async () => {
    expect((await get('app://depleted/secret.txt')).status).toBe(404)
    expect((await get('app://evil/index.html')).status).toBe(404)
    expect((await get('app://depleted/index.html', {}, 'POST')).status).toBe(405)
  })

  it('cannot climb out of the UI folder', async () => {
    expect((await get('app://depleted/..%2Foutside%2Fprivate.mp4')).status).toBe(404)
    expect((await get('app://depleted/%2E%2E/outside/private.mp4')).status).toBe(404)
    expect((await get(`app://depleted/${encodeURIComponent(join(outside, 'private.mp4'))}`)).status).toBe(404)
  })
})

describe('app:// media', () => {
  const recording = (): string => join(mediaRoot, 'run #1', 'recording.mp4')

  it('serves a recording inside the recordings folder, with spaces and # in the path', async () => {
    const res = await get(toMediaUrl(recording()))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('0123456789')
    expect((await get(toMediaUrl(join(mediaRoot, 'run #1', 'thumbnail.jpg')))).status).toBe(200)
  })

  it('answers range requests so the player can seek', async () => {
    const res = await get(toMediaUrl(recording()), { Range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
    const tail = await get(toMediaUrl(recording()), { Range: 'bytes=-3' })
    expect(await tail.text()).toBe('789')
    const past = await get(toMediaUrl(recording()), { Range: 'bytes=10-' })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */10')
  })

  it('HEAD has headers and no body', async () => {
    const res = await get(toMediaUrl(recording()), {}, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('')
  })

  it('refuses files outside the recordings folder, even through ../ or a symlink', async () => {
    expect((await get(toMediaUrl(join(outside, 'private.mp4')))).status).toBe(404)
    expect((await get(toMediaUrl(join(mediaRoot, '..', 'outside', 'private.mp4')))).status).toBe(404)
    expect((await get(`app://depleted/media${mediaRoot.split('/').map(encodeURIComponent).join('/')}/..%2F..%2Foutside%2Fprivate.mp4`)).status).toBe(404)
    expect((await get(toMediaUrl(join(mediaRoot, 'run #1', 'link.mp4')))).status).toBe(404)
  })

  it('only serves video and image files, judged by what a symlink really points at', async () => {
    expect((await get(toMediaUrl(join(mediaRoot, 'run #1', 'metadata.json')))).status).toBe(404)
    expect((await get(toMediaUrl(join(mediaRoot, 'run #1', 'meta.jpg')))).status).toBe(404)
    expect((await get(toMediaUrl(join(outside, 'private.txt')))).status).toBe(404)
  })

  it('refuses the folder itself and missing files', async () => {
    expect((await get(toMediaUrl(mediaRoot))).status).toBe(404)
    expect((await get(toMediaUrl(join(mediaRoot, 'run #1', 'nope.mp4')))).status).toBe(404)
  })
})

describe('parseRange', () => {
  it('reads single ranges and ignores what it does not handle', () => {
    expect(parseRange(null, 10)).toBeNull()
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=3-100', 10)).toEqual({ start: 3, end: 9 })
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull()
    expect(parseRange('bytes=5-2', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
    expect(parseRange('bytes=-', 10)).toBeNull()
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})
