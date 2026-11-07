// The app:// scheme the UI and recordings are served from (src/main/system/appProtocol.ts)

export const APP_SCHEME = 'app'
export const APP_HOST = 'depleted'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const MEDIA_PREFIX = 'media'

// The URL the renderer uses for a recording, clip or thumbnail on disk. The main process
// only serves it if it's inside the recordings folder.
export function toMediaUrl(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter((p) => p !== '')
  return `${APP_ORIGIN}/${MEDIA_PREFIX}/${parts.map(encodeURIComponent).join('/')}`
}
