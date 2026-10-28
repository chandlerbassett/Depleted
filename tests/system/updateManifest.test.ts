import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { updateEntry } = require('../../build/updateManifest.js') as {
  updateEntry: (yml: string, fileName: string, sha512: string, size: number) => string
}

const YML = `version: 1.1.2
files:
  - url: Depleted-1.1.2-arm64-mac.zip
    sha512: ZIPHASH==
    size: 128299154
  - url: Depleted-1.1.2-arm64.dmg
    sha512: OLDDMG==
    size: 133205219
path: Depleted-1.1.2-arm64-mac.zip
sha512: ZIPHASH==
releaseDate: '2026-10-28T15:48:08.917Z'
`

describe('updateEntry', () => {
  it('changes only the DMG entry, leaving the zip the updater downloads alone', () => {
    const out = updateEntry(YML, 'Depleted-1.1.2-arm64.dmg', 'NEW/DMG+==', 133300000)
    expect(out).toContain('  - url: Depleted-1.1.2-arm64.dmg\n    sha512: NEW/DMG+==\n    size: 133300000')
    expect(out.replace('NEW/DMG+==', 'OLDDMG==').replace('133300000', '133205219')).toBe(YML)
  })

  it('fails when the file is not in the manifest', () => {
    expect(() => updateEntry(YML, 'Other.dmg', 'x', 1)).toThrow('not in the manifest')
  })
})
