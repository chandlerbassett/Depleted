import { describe, it, expect, vi } from 'vitest'

const getSources = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ desktopCapturer: { getSources } }))

const { parseWowWindowIds, desktopCapturerWindowId } = await import('../../src/main/recorder/wowWindows')
const { listCaptureSources, resolveCaptureSource } = await import('../../src/main/recorder/sourceResolver')

const thumb = { isEmpty: () => true, toDataURL: () => '' }

describe('parseWowWindowIds', () => {
  it("reads the window ids from the helper's windows event", () => {
    const out = '{"event":"windows","windows":[{"id":4242,"title":"World of Warcraft"},{"id":7,"title":""}]}\n'
    expect([...parseWowWindowIds(out)]).toEqual([4242, 7])
  })

  it('ignores other lines and anything that is not a window id', () => {
    const out = [
      'not json',
      '{"event":"error","message":"x"}',
      '{"event":"windows","windows":[{"id":"12"},{"id":-1},{"id":1.5},null,{"id":99}]}'
    ].join('\n')
    expect([...parseWowWindowIds(out)]).toEqual([99])
  })
})

describe('desktopCapturerWindowId', () => {
  it('takes the CGWindowID from a window source id', () => {
    expect(desktopCapturerWindowId('window:4242:0')).toBe(4242)
    expect(desktopCapturerWindowId('screen:1:0')).toBeNull()
    expect(desktopCapturerWindowId('window:abc:0')).toBeNull()
  })
})

describe('listCaptureSources', () => {
  it('lists only the given windows, and no screens, when WoW window ids are given', async () => {
    getSources.mockResolvedValueOnce([
      { id: 'window:4242:0', name: 'World of Warcraft', thumbnail: thumb },
      { id: 'window:5000:0', name: 'Bank statement.pdf', thumbnail: thumb },
      { id: 'screen:1:0', name: 'Entire screen', thumbnail: thumb }
    ])
    const sources = await listCaptureSources(new Set([4242]))
    expect(sources.map((s) => s.name)).toEqual(['World of Warcraft'])
    expect(sources[0]!.isLikelyWow).toBe(true)
    expect(getSources.mock.calls.at(-1)![0].types).toEqual(['window'])
  })

  it('lists nothing when no WoW window is open', async () => {
    getSources.mockResolvedValueOnce([{ id: 'window:5000:0', name: 'Mail', thumbnail: thumb }])
    expect(await listCaptureSources(new Set())).toEqual([])
  })
})

describe('resolveCaptureSource', () => {
  it("does not put other windows' titles in the error", async () => {
    getSources.mockResolvedValueOnce([
      { id: 'window:1:0', name: 'Secret project - Google Docs', thumbnail: thumb },
      { id: 'window:2:0', name: 'Mail', thumbnail: thumb }
    ])
    const err = await resolveCaptureSource('auto').catch((e: unknown) => e as Error)
    expect(err.message).toContain('2 other windows open')
    expect(err.message).not.toContain('Secret project')
    expect(err.message).not.toContain('Mail')
  })
})
