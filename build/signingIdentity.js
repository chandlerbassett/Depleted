// Picks the code-signing identity for local macOS builds.
//
// macOS ties the Screen Recording grant to the app's designated requirement. An ad-hoc
// signature's requirement is its own cdhash, which changes on every build, so the grant
// had to be redone after each rebuild. Signing with the same certificate every time
// keeps the requirement (bundle ID + certificate) stable, so the grant sticks.
//
// Order: $DEPLETED_SIGN_IDENTITY, then the "Depleted Local Signing" certificate made by
// scripts/create-signing-cert.sh if it's in the keychain, else ad-hoc ("-").

const { execFileSync } = require('child_process')

const LOCAL_IDENTITY = 'Depleted Local Signing'

function signingIdentity() {
  const fromEnv = process.env.DEPLETED_SIGN_IDENTITY
  if (fromEnv) return fromEnv
  try {
    const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
    if (identities.includes(`"${LOCAL_IDENTITY}"`)) return LOCAL_IDENTITY
  } catch {
    // No keychain access (e.g. CI): fall back to ad-hoc
  }
  return '-'
}

module.exports = { signingIdentity, LOCAL_IDENTITY }
