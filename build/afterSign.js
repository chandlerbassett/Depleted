// Re-signs the app bundle after electron-builder's ad-hoc sign so that Info.plist is
// bound and the TCC identifier matches the bundle ID. Uses the stable local identity
// from signingIdentity.js when there is one, so Screen Recording survives rebuilds.
// Only runs on macOS, and not when electron-builder signed with a Developer ID.

const { execFileSync, spawnSync } = require('child_process')
const { signingIdentity } = require('./signingIdentity')

module.exports = async function afterSign({ appOutDir, packager, electronPlatformName }) {
  // electronPlatformName reflects the BUILD TARGET (darwin/win32/linux), not the host
  // OS running electron-builder — process.platform would stay 'darwin' even while
  // cross-building a Windows target from macOS, wrongly trying to codesign a
  // nonexistent .app bundle instead of the .exe electron-builder actually produced.
  if (electronPlatformName !== 'darwin') return

  const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`
  // Signed (and notarized) with a Developer ID already: re-signing would break both
  if (developerIdSigned(appPath)) return

  const identity = signingIdentity()
  console.log(`[afterSign] Re-signing ${appPath} with ${identity === '-' ? 'ad-hoc' : `"${identity}"`}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' })
}

function developerIdSigned(appPath) {
  // codesign prints the signature details on stderr
  const { stderr } = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' })
  return (stderr ?? '').includes('Authority=Developer ID Application')
}
