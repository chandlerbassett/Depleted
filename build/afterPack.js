// Flips Depleted's Electron fuses (build/fuses.js says what each one is for). Runs
// before signing, which covers the change.

const { flipFuses, FuseVersion } = require('@electron/fuses')
const { FUSES } = require('./fuses')

module.exports = async function afterPack({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return

  await flipFuses(`${appOutDir}/${packager.appInfo.productFilename}.app`, {
    version: FuseVersion.V1,
    // Flipping fuses breaks the binary's signature; arm64 won't run it unsigned
    resetAdHocDarwinSignature: true,
    ...FUSES
  })
}
