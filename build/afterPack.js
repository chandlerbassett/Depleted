// Turns off the Electron switches that let another program run its own code as
// Depleted (and so with Depleted's Screen Recording permission): ELECTRON_RUN_AS_NODE,
// NODE_OPTIONS and --inspect. Also makes Electron load the app only from app.asar and
// check it against the hash in Info.plist. Runs before signing, which covers the change.

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName !== 'darwin') return

  await flipFuses(`${appOutDir}/${packager.appInfo.productFilename}.app`, {
    version: FuseVersion.V1,
    // Flipping fuses breaks the binary's signature; arm64 won't run it unsigned
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true
  })
}
