import { app } from 'electron'

/**
 * The electron-vite dev server URL, only in a dev run.
 *
 * A packaged app ignores ELECTRON_RENDERER_URL: otherwise anything that can relaunch
 * Depleted (`open -a Depleted --env ELECTRON_RENDERER_URL=...`) could load its own page
 * into a window that has the preload bridge, and use the app's Screen Recording grant.
 */
export function devRendererUrl(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.ELECTRON_RENDERER_URL || undefined
}
