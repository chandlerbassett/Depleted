// Re-signs the app bundle after electron-builder's ad-hoc sign so that Info.plist is
// bound and the TCC identifier matches the bundle ID. Uses the stable local identity
// from signingIdentity.js when there is one, so Screen Recording survives rebuilds.
// Only runs on macOS when no Developer ID is configured in electron-builder.yml.

const { execFileSync } = require('child_process')
const { signingIdentity } = require('./signingIdentity')

module.exports = async function afterSign({ appOutDir, packager, electronPlatformName }) {
  // electronPlatformName reflects the BUILD TARGET (darwin/win32/linux), not the host
  // OS running electron-builder — process.platform would stay 'darwin' even while
  // cross-building a Windows target from macOS, wrongly trying to codesign a
  // nonexistent .app bundle instead of the .exe electron-builder actually produced.
  if (electronPlatformName !== 'darwin') return

  const configured = packager.config.mac?.identity
  // Skip when a real Developer ID is configured — it handles signing correctly.
  if (configured && configured !== '-') return

  const identity = signingIdentity()
  const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`
  console.log(`[afterSign] Re-signing ${appPath} with ${identity === '-' ? 'ad-hoc' : `"${identity}"`}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' })
}
