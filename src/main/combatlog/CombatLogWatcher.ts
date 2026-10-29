// Watches WoW combat log files via chokidar, reads only new lines using a byte offset.
//
// Two modes:
//   1. Direct file mode (legacy): pass a single filePath. Watches that exact file.
//   2. Glob mode: pass { dir, glob } — watches the directory for any matching file and
//      automatically follows the most recently created one (handles WoW's timestamped
//      log files like WoWCombatLog-041726_144858.txt).
//
// On each file change, reads from the last known offset to EOF.
// On file rotation (size < offset), resets offset to 0.

import { EventEmitter } from 'events'
import { promises as fs, readdirSync, statSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import chokidar from 'chokidar'
import { CombatLogParser } from './CombatLogParser'
import type { ParserEventMap } from './CombatLogParser'

// The most read from the log at once when catching up
const READ_CHUNK_BYTES = 4 * 1024 * 1024

export interface WatcherOptions {
  // Use polling instead of native fs events. Useful on network drives.
  usePolling?: boolean
}

export interface GlobWatchTarget {
  dir: string
  glob: string
}

export class CombatLogWatcher extends EventEmitter {
  public readonly parser: CombatLogParser

  private readonly target: string | GlobWatchTarget
  private readonly options: WatcherOptions

  private currentFile: string | null = null
  private fileOffsets = new Map<string, number>()

  private watcher: chokidar.FSWatcher | null = null
  private processing = false
  // Set to true when a change event arrives while processing is in flight.
  // After the current read finishes, we do one more read to catch up.
  private pendingRead = false
  // Fallback poll interval — fires every 2 s to catch writes chokidar may miss.
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(target: string | GlobWatchTarget, options: WatcherOptions = {}) {
    super()
    this.target = target
    this.options = options
    this.parser = new CombatLogParser()
  }

  onParser<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    this.parser.on(event, listener)
    return this
  }

  offParser<K extends keyof ParserEventMap>(
    event: K,
    listener: (payload: ParserEventMap[K]) => void
  ): this {
    this.parser.off(event, listener)
    return this
  }

  start(): void {
    if (this.watcher !== null) return

    let watchPath: string

    if (typeof this.target === 'string') {
      // Direct-file mode: read from the beginning, process all history.
      watchPath = this.target
      this.currentFile = this.target
      this.fileOffsets.set(this.target, 0)
    } else {
      watchPath = join(this.target.dir, this.target.glob)

      // Glob mode: find all already-existing log files right now, synchronously.
      // Pick the most recently modified one and seek its offset to EOF so we never
      // replay historical matches from sessions before this app launch.
      const existing = matchingFiles(this.target.dir, this.target.glob)
      if (existing.length > 0) {
        const mostRecent = resolvePath(existing
          .map((f) => {
            try { return { f, mtime: statSync(f).mtimeMs } } catch { return { f, mtime: 0 } }
          })
          .sort((a, b) => b.mtime - a.mtime)[0].f)

        this.currentFile = mostRecent
        const fileSize = (() => { try { return statSync(mostRecent).size } catch { return 0 } })()
        // Read the last 50 KB at startup to catch a ZONE_CHANGE / CHALLENGE_MODE_START
        // that was written just before this process started.
        const lookbackBytes = 50 * 1024
        const startOffset = Math.max(0, fileSize - lookbackBytes)
        this.fileOffsets.set(mostRecent, startOffset)
        console.warn(`[Watcher] Starting near EOF of existing log (offset ${startOffset}/${fileSize}): ${mostRecent}`)
      }
    }

    // ignoreInitial: true — we already handled existing files above; only watch for
    // changes/new files created after this point.
    // usePolling: true — FSEvents on macOS misses rapid sequential writes (WoW pattern).
    this.watcher = chokidar.watch(watchPath, {
      persistent: true,
      usePolling: true,
      interval: 1000,
      ignoreInitial: true,
      awaitWriteFinish: false
    })

    this.watcher.on('add', (filePath: string) => {
      const resolved = resolvePath(filePath)
      if (typeof this.target !== 'string') {
        // A genuinely new file was created while the app is running (new WoW session).
        this.currentFile = resolved
        this.fileOffsets.set(resolved, 0)
        this.parser.reset()
        console.warn(`[Watcher] New log file detected, switching: ${resolved}`)
        void this.processNewLines(resolved)
        // Follow-up reads catch burst writes on WoW session start.
        setTimeout(() => { void this.processNewLines(resolved) }, 800)
        setTimeout(() => { void this.processNewLines(resolved) }, 2000)
      } else {
        void this.processNewLines(resolved)
      }
    })

    this.watcher.on('change', (filePath: string) => {
      const resolved = resolvePath(filePath)
      console.warn(`[Watcher] change event: ${resolved} (current: ${this.currentFile ?? 'none'})`)
      if (resolved !== this.currentFile) return
      void this.processNewLines(resolved)
    })

    this.watcher.on('error', (err: unknown) => {
      this.emit('error', err)
    })

    // Fallback poll: chokidar FSEvents can miss rapid writes on macOS.
    // Every 2 s, check if the current file has grown since the last read.
    this.pollTimer = setInterval(() => {
      if (this.currentFile !== null) {
        void this.processNewLines(this.currentFile)
      }
    }, 2000)
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    void this.watcher?.close()
    this.watcher = null
  }

  getOffset(): number {
    return this.fileOffsets.get(this.currentFile ?? '') ?? 0
  }

  resetOffset(): void {
    if (this.currentFile !== null) {
      this.fileOffsets.set(this.currentFile, 0)
    }
  }

  private async processNewLines(filePath: string): Promise<void> {
    if (this.processing) {
      this.pendingRead = true
      return
    }
    this.processing = true

    try {
      await this.doRead(filePath)
      // Drain any pending read that arrived while we were processing.
      while (this.pendingRead) {
        this.pendingRead = false
        await this.doRead(filePath)
      }
    } finally {
      this.processing = false
    }
  }

  // Parses the complete lines added since the last read. A line WoW is still writing
  // (no newline yet) is left for the next read, and big catch-ups are read in chunks.
  private async doRead(filePath: string): Promise<void> {
    let size: number
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      return
    }

    let offset = this.fileOffsets.get(filePath) ?? 0
    // File rotation: size shrank — reset to beginning
    if (size < offset) offset = 0
    if (size === offset) {
      this.fileOffsets.set(filePath, offset)
      return
    }

    const fd = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - offset))
      while (offset < size) {
        const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
        if (bytesRead === 0) break
        const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1)
        // No newline yet: the line is still being written. Wait for the rest, unless it
        // fills a whole chunk, which no combat log line does.
        if (lastNewline < 0 && bytesRead < buffer.length) break
        const end = lastNewline < 0 ? bytesRead : lastNewline + 1
        this.processText(buffer.toString('utf8', 0, end))
        offset += end
        this.fileOffsets.set(filePath, offset)
      }
    } finally {
      await fd.close()
    }
    this.fileOffsets.set(filePath, offset)
  }

  private processText(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        this.parser.processLine(trimmed)
      }
    }
  }
}

// Files in dir whose names match a pattern where * stands for any characters
// ("WoWCombatLog*.txt"), as chokidar matches them while watching
export function matchingFiles(dir: string, pattern: string): string[] {
  const literal = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`^${literal.join('.*')}$`)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => !name.startsWith('.') && re.test(name)).map((name) => join(dir, name))
}
