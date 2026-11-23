import { app } from 'electron'

/**
 * A packaged Depleted never needs a command-line switch, so it refuses to start with any.
 * Chromium honours many switches in a release build, and some hand the app's powers to
 * whoever relaunched it: `--remote-debugging-port` opens a DevTools endpoint into the
 * window and its preload bridge, and `--gpu-launcher`, `--renderer-cmd-prefix` and
 * `--utility-cmd-prefix` run another program as Depleted's child, which macOS lets use
 * Depleted's Screen Recording permission. A denylist would miss the next one; refusing
 * every switch doesn't. (The EnableNodeCliInspectArguments fuse only covers Node's own.)
 *
 * argv[0] is the executable. Finder, the Dock, login items and the updater's relaunch
 * pass no switches. Old macOS versions added a "-psn_..." process serial number, which
 * has a single dash and is let through.
 */
export function forbiddenSwitch(argv: readonly string[] = process.argv): string | undefined {
  if (!app.isPackaged) return undefined
  return argv.slice(1).find((arg) => arg.startsWith('--') || (arg.startsWith('-') && !arg.startsWith('-psn_')))
}
