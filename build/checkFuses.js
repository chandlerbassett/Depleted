#!/usr/bin/env node
// Reads the fuses from a packaged Depleted.app and fails unless every one is set the way
// build/fuses.js says. CI and the release build run it, so a change to electron-builder
// or Electron that skips afterPack can't ship an app with the fuses left on.
// Usage: node build/checkFuses.js <Depleted.app>

const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
const { FUSES } = require('./fuses')

// The byte each fuse holds in the binary ('0', '1'); @electron/fuses doesn't export these
const FuseState = { 48: 'DISABLE', 49: 'ENABLE', 114: 'REMOVED', 144: 'INHERIT', DISABLE: 48, ENABLE: 49 }

async function main() {
  const app = process.argv[2]
  if (!app) throw new Error('usage: checkFuses.js <Depleted.app>')
  const wire = await getCurrentFuseWire(app)
  const wrong = []
  for (const [option, wanted] of Object.entries(FUSES)) {
    const expected = wanted ? FuseState.ENABLE : FuseState.DISABLE
    if (wire[option] !== expected) {
      wrong.push(`${FuseV1Options[option]} is ${FuseState[wire[option]] ?? wire[option]}, expected ${FuseState[expected]}`)
    }
  }
  if (wrong.length > 0) {
    for (const line of wrong) console.error(`::error::checkFuses: ${line}`)
    process.exit(1)
  }
  console.log(`checkFuses: ${app}: all ${Object.keys(FUSES).length} fuses set as build/fuses.js says`)
}

main().catch((err) => {
  console.error(`::error::checkFuses: ${err.message}`)
  process.exit(1)
})
