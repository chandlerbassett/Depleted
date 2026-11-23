// Every IPC handler goes through here, so a call is only acted on when it comes from the
// app's own page: the top frame of a window showing app://depleted (or, in a dev run
// only, the electron-vite dev server). The preload bridge already limits which channels
// a page can reach; this limits which page can reach them. If some other page ever got
// the preload (a new load path, a navigation that slipped through, a subframe), its calls
// are refused here instead of reaching the handlers.
//
// Checked against Electron: senderFrame.origin is 'app://depleted' for the app's pages
// (the scheme is registered as standard), and a srcdoc or about:blank subframe inherits
// its parent's origin, which is why the frame must also be the top frame.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { APP_ORIGIN } from '@shared/appUrl'
import { devRendererUrl } from './devRendererUrl'

// The parts of WebFrameMain the check reads
export interface SenderFrame {
  readonly origin: string
  readonly parent: unknown
}

// The origins whose pages may call the main process
export function trustedOrigins(): string[] {
  const origins = [APP_ORIGIN]
  const dev = devRendererUrl()
  if (dev !== undefined) {
    try {
      origins.push(new URL(dev).origin)
    } catch {
      // Not a URL: no dev origin
    }
  }
  return origins
}

export function isTrustedFrame(frame: SenderFrame | null | undefined, origins: readonly string[] = trustedOrigins()): boolean {
  if (frame === null || frame === undefined) return false
  if (frame.parent !== null) return false
  return origins.includes(frame.origin)
}

// senderFrame is null once the frame has gone or navigated away, and reading it (or its
// origin or parent) can throw while it is being torn down; either way the call isn't
// from a trusted page
export function isTrustedSender(event: Pick<IpcMainEvent, 'senderFrame'>): boolean {
  try {
    return isTrustedFrame(event.senderFrame)
  } catch {
    return false
  }
}

function describeSender(event: Pick<IpcMainEvent, 'senderFrame'>): string {
  try {
    const frame = event.senderFrame
    if (!frame) return 'a frame that is gone'
    return `${frame.parent === null ? 'top frame' : 'subframe'} of origin ${JSON.stringify(frame.origin)}`
  } catch {
    return 'a frame that is gone'
  }
}

// ipcMain.handle, refusing calls from anything but the app's own page
export function handle<A extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => R
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`[IPC] Refused ${channel} from ${describeSender(event)}`)
      throw new Error('Refused: not the Depleted window')
    }
    return listener(event, ...(args as A))
  })
}
