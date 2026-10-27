import { app } from 'electron'
import { join } from 'path'
import { NATIVE_HELPER_NAME } from './nativeHelper'

// Packaged: Contents/Resources/bin (electron-builder extraResources).
// Dev: native/bin under the project root, written by `npm run build:native`.
export function nativeHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', NATIVE_HELPER_NAME)
    : join(app.getAppPath(), 'native', 'bin', NATIVE_HELPER_NAME)
}
