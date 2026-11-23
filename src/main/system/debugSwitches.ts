import { app } from 'electron'

/**
 * Chromium switches that open a DevTools protocol endpoint. The
 * EnableNodeCliInspectArguments fuse only turns off Node's --inspect, so a released
 * app has to refuse these itself: anything that relaunches Depleted with
 * `--remote-debugging-port` could otherwise drive the window and its preload bridge.
 */
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const

/** The debugging switch a packaged app was started with, if any. */
export function forbiddenDebugSwitch(): string | undefined {
  if (!app.isPackaged) return undefined
  return DEBUG_SWITCHES.find((name) => app.commandLine.hasSwitch(name))
}
