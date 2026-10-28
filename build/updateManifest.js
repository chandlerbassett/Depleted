// Updates the size and sha512 of files in latest-mac.yml after they were changed
// post-build (the DMG is signed, notarized and stapled after electron-builder wrote the
// manifest). Usage: node build/updateManifest.js dist/latest-mac.yml dist/*.dmg

const { createHash } = require('crypto')
const { readFileSync, statSync, writeFileSync } = require('fs')
const { basename } = require('path')

// Replaces the sha512 and size lines that follow "- url: <fileName>"
function updateEntry(yml, fileName, sha512, size) {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const entry = new RegExp(`(- url: ${escaped}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`)
  if (!entry.test(yml)) throw new Error(`${fileName} is not in the manifest`)
  return yml.replace(entry, `$1${sha512}$2${size}`)
}

function main([manifestPath, ...files]) {
  let yml = readFileSync(manifestPath, 'utf8')
  for (const file of files) {
    const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64')
    yml = updateEntry(yml, basename(file), sha512, statSync(file).size)
    console.log(`[updateManifest] ${basename(file)}: ${sha512}`)
  }
  writeFileSync(manifestPath, yml)
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { updateEntry }
