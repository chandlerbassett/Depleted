// The Electron fuses Depleted ships with. afterPack.js flips them; checkFuses.js reads
// them back from a packaged app and fails if any differs.
//
//   RunAsNode, NodeOptions, NodeCliInspect off: another program can't run its own code
//     as Depleted (and so with Depleted's Screen Recording permission)
//   EmbeddedAsarIntegrityValidation + OnlyLoadAppFromAsar on: the app loads only from
//     app.asar, checked against the hash in Info.plist
//   GrantFileProtocolExtraPrivileges off: the UI and recordings load over app://
//     (src/main/system/appProtocol.ts), so file:// pages need none of Chromium's extra
//     file privileges

const { FuseV1Options } = require('@electron/fuses')

const FUSES = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
}

module.exports = { FUSES }
