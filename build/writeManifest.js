// Writes latest-mac.yml, which installed copies of Depleted read to find and check an
// update. The release workflow runs it in its publish job, from the files as published:
// nothing in the manifest comes from the job that ran electron-builder. Node's own modules
// only, as that job installs no npm packages.
// Usage: node build/writeManifest.js <out.yml> <version> <app zip> <dmg>

const { createHash } = require('crypto')
const { readFileSync, statSync, writeFileSync } = require('fs')
const { basename } = require('path')

const VERSION = /^\d+\.\d+\.\d+$/
const FILE_NAME = /^[A-Za-z0-9._-]+$/

// files: [{ name, sha512, size }]; the first is the zip the updater installs
function buildManifest(version, files, releaseDate) {
  if (!VERSION.test(version)) throw new Error(`Not a version: ${version}`)
  for (const file of files) {
    if (!FILE_NAME.test(file.name)) throw new Error(`Not a plain file name: ${file.name}`)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(file.sha512)) throw new Error(`Not a base64 sha512: ${file.sha512}`)
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`Bad size for ${file.name}`)
  }
  const [zip] = files
  if (zip === undefined || !zip.name.endsWith('.zip')) throw new Error('The first file must be the zip')
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f.name}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${zip.name}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`,
    ''
  ].join('\n')
}

function describe(path) {
  return {
    name: basename(path),
    sha512: createHash('sha512').update(readFileSync(path)).digest('base64'),
    size: statSync(path).size
  }
}

function main([outPath, version, ...paths]) {
  const yml = buildManifest(version, paths.map(describe), new Date())
  writeFileSync(outPath, yml)
  process.stdout.write(yml)
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { buildManifest }
