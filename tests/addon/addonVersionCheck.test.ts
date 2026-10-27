import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareVersions, getInstalledAddonVersion, getBundledAddonVersion, isInstalledAddonOutdated } from '../../src/main/addon/addonVersionCheck'

describe('compareVersions', () => {
  it('is 0 for equal versions', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
  })

  it('is negative when a is older', () => {
    expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0)
  })

  it('is positive when a is newer', () => {
    expect(compareVersions('1.3.0', '1.2.0')).toBeGreaterThan(0)
  })
})

describe('getInstalledAddonVersion / getBundledAddonVersion / isInstalledAddonOutdated', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'arc-addon-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeToc(dir: string, version: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'DepletedCompanion.toc'), `## Interface: 120001\n## Version: ${version}\n`)
  }

  it('reads the installed .toc version', () => {
    const wowPath = join(root, 'wow')
    writeToc(join(wowPath, '_retail_', 'Interface', 'AddOns', 'DepletedCompanion'), '1.2.0')
    expect(getInstalledAddonVersion(wowPath)).toBe('1.2.0')
  })

  it('returns null when the installed addon is missing', () => {
    expect(getInstalledAddonVersion(join(root, 'wow'))).toBeNull()
  })

  it('reads the bundled .toc version', () => {
    const bundledDir = join(root, 'bundled')
    writeToc(join(bundledDir, 'DepletedCompanion'), '1.3.0')
    expect(getBundledAddonVersion(bundledDir)).toBe('1.3.0')
  })

  it('flags outdated when installed is older than bundled', () => {
    const wowPath = join(root, 'wow')
    const bundledDir = join(root, 'bundled')
    writeToc(join(wowPath, '_retail_', 'Interface', 'AddOns', 'DepletedCompanion'), '1.1.0')
    writeToc(join(bundledDir, 'DepletedCompanion'), '1.2.0')
    expect(isInstalledAddonOutdated(wowPath, bundledDir)).toBe(true)
  })

  it('does not flag when installed matches bundled', () => {
    const wowPath = join(root, 'wow')
    const bundledDir = join(root, 'bundled')
    writeToc(join(wowPath, '_retail_', 'Interface', 'AddOns', 'DepletedCompanion'), '1.2.0')
    writeToc(join(bundledDir, 'DepletedCompanion'), '1.2.0')
    expect(isInstalledAddonOutdated(wowPath, bundledDir)).toBe(false)
  })

  it('does not flag when the addon is not installed at all', () => {
    const bundledDir = join(root, 'bundled')
    writeToc(join(bundledDir, 'DepletedCompanion'), '1.2.0')
    expect(isInstalledAddonOutdated(join(root, 'wow'), bundledDir)).toBe(false)
  })
})
