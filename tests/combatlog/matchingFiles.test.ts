import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { matchingFiles } from '../../src/main/combatlog/CombatLogWatcher'

describe('matchingFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'depleted-logs-'))
    for (const name of ['WoWCombatLog-102826_201500.txt', 'WoWCombatLog.txt', 'WoWCombatLogXtxt', 'Other.txt', '.WoWCombatLog-x.txt']) {
      writeFileSync(join(dir, name), '')
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists the files the pattern matches, with * as any characters and . as a dot', () => {
    expect(matchingFiles(dir, 'WoWCombatLog*.txt').sort()).toEqual([
      join(dir, 'WoWCombatLog-102826_201500.txt'),
      join(dir, 'WoWCombatLog.txt')
    ])
  })

  it('returns nothing for a folder that does not exist', () => {
    expect(matchingFiles(join(dir, 'missing'), 'WoWCombatLog*.txt')).toEqual([])
  })
})
