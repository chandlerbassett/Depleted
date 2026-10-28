import { describe, it, expect, vi, beforeEach } from 'vitest'

const openExternal = vi.fn(async () => {})
vi.mock('electron', () => ({ shell: { openExternal } }))

const { openExternalUrl } = await import('../../src/main/system/openExternal')

describe('openExternalUrl', () => {
  beforeEach(() => openExternal.mockClear())

  it('opens https links in the browser', async () => {
    await openExternalUrl('https://raider.io/characters/us/area-52/Gobitron')
    expect(openExternal).toHaveBeenCalledWith('https://raider.io/characters/us/area-52/Gobitron')
  })

  it.each(['file:///Applications/Calculator.app', 'http://example.com', 'smb://host/share', 'javascript:alert(1)', 'not a url'])(
    'refuses %s',
    async (url) => {
      await expect(openExternalUrl(url)).rejects.toThrow()
      expect(openExternal).not.toHaveBeenCalled()
    }
  )
})
