// Copies the main process's console.warn/error output to ~/Library/Logs/Depleted/main.log, so a
// problem on someone's Mac (an update check, a recording that didn't save) can be
// diagnosed after the fact. Starts over at 5 MB, keeping the previous file as main.old.log.

import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

const MAX_BYTES = 5 * 1024 * 1024

export function startLogFile(): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'main.log')
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, join(dir, 'main.old.log'))
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 })
    stream.on('error', () => undefined)

    const write = (level: string, args: unknown[]): void => {
      stream.write(`${new Date().toISOString()} ${level} ${format(...args)}\n`)
    }
    const warn = console.warn.bind(console)
    const error = console.error.bind(console)
    console.warn = (...args: unknown[]): void => {
      warn(...args)
      write('WARN', args)
    }
    console.error = (...args: unknown[]): void => {
      error(...args)
      write('ERROR', args)
    }
  } catch {
    // Logging to a file is best effort
  }
}
