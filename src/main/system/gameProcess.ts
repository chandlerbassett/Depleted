// Whether World of Warcraft is running, for the always-on pre-roll buffer. pgrep exits 0
// when a process with exactly this name exists and 1 when none does.

import { execFile } from 'child_process'

const WOW_PROCESS_NAME = 'World of Warcraft'

export function isWowRunning(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pgrep', ['-x', WOW_PROCESS_NAME], (err) => {
      if (err === null) resolve(true)
      else if (err.code === 1) resolve(false)
      else reject(err)
    })
  })
}
