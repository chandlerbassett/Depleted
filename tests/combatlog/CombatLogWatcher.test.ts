import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CombatLogWatcher } from '../../src/main/combatlog/CombatLogWatcher'

// Reads what's new in the file the way a change event or the poll does
function readNew(watcher: CombatLogWatcher, file: string): Promise<void> {
  return (watcher as unknown as { processNewLines(f: string): Promise<void> }).processNewLines(file)
}

describe('CombatLogWatcher reads', () => {
  let dir: string
  let file: string
  let watcher: CombatLogWatcher
  let lines: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'depleted-watch-'))
    file = join(dir, 'WoWCombatLog.txt')
    writeFileSync(file, '')
    watcher = new CombatLogWatcher(file)
    lines = []
    vi.spyOn(watcher.parser, 'processLine').mockImplementation((line: string) => {
      lines.push(line)
    })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('waits for the rest of a line WoW is still writing', async () => {
    appendFileSync(file, '10/28 20:00:00.000-4  ZONE_CHANGE,2521,"Ruby Life Pools",8\n10/28 20:00:01.000-4  ENCOUNTER_')
    await readNew(watcher, file)
    expect(lines).toEqual(['10/28 20:00:00.000-4  ZONE_CHANGE,2521,"Ruby Life Pools",8'])

    appendFileSync(file, 'END,2609,"Melidrussa Chillworn",8,5,1,95000\n')
    await readNew(watcher, file)
    expect(lines).toEqual([
      '10/28 20:00:00.000-4  ZONE_CHANGE,2521,"Ruby Life Pools",8',
      '10/28 20:00:01.000-4  ENCOUNTER_END,2609,"Melidrussa Chillworn",8,5,1,95000'
    ])
  })

  it('reads a large backlog in chunks without losing or splitting lines', async () => {
    const line = (i: number): string => `10/28 20:00:00.000-4  SPELL_CAST_SUCCESS,${i},${'x'.repeat(200)}`
    const count = 30_000 // about 6.5 MB, more than one chunk
    appendFileSync(file, Array.from({ length: count }, (_, i) => line(i) + '\n').join(''))
    await readNew(watcher, file)
    expect(lines.length).toBe(count)
    expect(lines[0]).toBe(line(0))
    expect(lines[count - 1]).toBe(line(count - 1))
    expect(lines.every((l, i) => l === line(i))).toBe(true)
  })

  it('keeps multi-byte names intact', async () => {
    appendFileSync(file, '10/28 20:00:00.000-4  UNIT_DIED,Player-1,"Gobitrön-Area52",0x511\n')
    await readNew(watcher, file)
    expect(lines).toEqual(['10/28 20:00:00.000-4  UNIT_DIED,Player-1,"Gobitrön-Area52",0x511'])
  })
})
