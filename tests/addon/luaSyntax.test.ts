// The companion addon ships as plain Lua that only WoW ever runs, so a syntax error
// (an unclosed string, a missing `end`) would otherwise reach players unnoticed:
// the whole addon fails to load in game. WoW runs Lua 5.1, so parse as 5.1.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
// @ts-expect-error luaparse has no bundled types
import luaparse from 'luaparse'

const ADDON_DIR = join(__dirname, '../../addon')

function luaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? luaFiles(join(dir, e.name)) : e.name.endsWith('.lua') ? [join(dir, e.name)] : []
  )
}

describe('addon Lua syntax', () => {
  const files = luaFiles(ADDON_DIR)

  it('finds the addon files', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [f.slice(ADDON_DIR.length + 1), f]))('%s parses as Lua 5.1', (_name, file) => {
    expect(() => luaparse.parse(readFileSync(file, 'utf8'), { luaVersion: '5.1' })).not.toThrow()
  })

  it('catches an unclosed string', () => {
    expect(() => luaparse.parse('print("no closing quote\nprint("next")', { luaVersion: '5.1' })).toThrow()
  })
})
