import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { buildManifest } = require('../../build/writeManifest.js') as {
  buildManifest: (version: string, files: { name: string; sha512: string; size: number }[], releaseDate: Date) => string
}

// v1.4.2's latest-mac.yml as electron-builder wrote it
const V142 = `version: 1.4.2
files:
  - url: Depleted-1.4.2-arm64-mac.zip
    sha512: frH3QfuTct8D6/k6FgBP6QxNzgWD5Ld9mp3gkhs7hnkDEmEsVMeOmSX+kf03f9q/1orVF9lSBQBg9idBaH5O8A==
    size: 116832413
  - url: Depleted-1.4.2-arm64.dmg
    sha512: EW81/1w78qg6E3hnmYI2UHk4ZNAMB+RBCs/sJJIELp5tT+jIJf2mbgyHhr4VIncwmQ9F77EhR38HyJTxHKtCMQ==
    size: 121140596
path: Depleted-1.4.2-arm64-mac.zip
sha512: frH3QfuTct8D6/k6FgBP6QxNzgWD5Ld9mp3gkhs7hnkDEmEsVMeOmSX+kf03f9q/1orVF9lSBQBg9idBaH5O8A==
releaseDate: '2026-11-04T20:29:30.822Z'
`

const files = [
  { name: 'Depleted-1.4.2-arm64-mac.zip', sha512: 'frH3QfuTct8D6/k6FgBP6QxNzgWD5Ld9mp3gkhs7hnkDEmEsVMeOmSX+kf03f9q/1orVF9lSBQBg9idBaH5O8A==', size: 116832413 },
  { name: 'Depleted-1.4.2-arm64.dmg', sha512: 'EW81/1w78qg6E3hnmYI2UHk4ZNAMB+RBCs/sJJIELp5tT+jIJf2mbgyHhr4VIncwmQ9F77EhR38HyJTxHKtCMQ==', size: 121140596 }
]

describe('buildManifest', () => {
  it('writes the same manifest electron-builder did', () => {
    expect(buildManifest('1.4.2', files, new Date('2026-11-04T20:29:30.822Z'))).toBe(V142)
  })

  it('refuses odd versions, file names and hashes', () => {
    const date = new Date()
    expect(() => buildManifest('1.4.2\nstagingPercentage: 1', files, date)).toThrow('Not a version')
    expect(() => buildManifest('1.4.2', [{ ...files[0]!, name: '../evil.zip' }], date)).toThrow('plain file name')
    expect(() => buildManifest('1.4.2', [{ ...files[0]!, sha512: 'x y' }], date)).toThrow('base64')
    expect(() => buildManifest('1.4.2', [files[1]!, files[0]!], date)).toThrow('first file must be the zip')
  })
})
