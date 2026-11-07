// Serves the app over app://depleted instead of file://, so Electron's
// GrantFileProtocolExtraPrivileges fuse can be off (build/afterPack.js) and the page's
// CSP needs no file: source.
//
//   app://depleted/<path>             the bundled UI (out/renderer), nothing else
//   app://depleted/media/<abs path>   a recording, clip or thumbnail, only from inside
//                                     the recordings folder and only video/image files
//
// Everything else gets a 404. Files are streamed with Range support so the video player
// can seek.

import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { Readable } from 'stream'
import { APP_SCHEME, APP_HOST, MEDIA_PREFIX } from '@shared/appUrl'

export interface AppProtocolRoots {
  // out/renderer: the built UI
  uiRoot: string
  // The recordings folder this run of the app uses (fixed until restart, like
  // StorageManager's)
  mediaRoot: string
}

// Every page the app serves gets this policy as a header too (index.html also has it as
// a meta tag; the capture page has none)
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "media-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-src 'none'"

const UI_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

// Only what the app itself writes into the recordings folder
const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg'
}

// Must run before the app's 'ready' event
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      // standard: real origin and relative URLs; secure: treated like https;
      // stream: the <video> element can stream and seek. No supportFetchAPI: the page
      // never fetch()es, so its script can't read a recording's bytes either.
      privileges: { standard: true, secure: true, stream: true }
    }
  ])
}

export function handleAppProtocol(roots: AppProtocolRoots): void {
  protocol.handle(APP_SCHEME, (request) => handleAppRequest(request, roots))
}

export async function handleAppRequest(request: Request, roots: AppProtocolRoots): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(405)
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return notFound()

  let segments: string[]
  try {
    segments = url.pathname.split('/').filter((s) => s !== '').map(decodeURIComponent)
  } catch {
    return notFound()
  }
  // Each segment is one path part: no separators, NULs or dot-dirs smuggled in encoded
  if (segments.some((s) => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))) {
    return notFound()
  }

  if (segments[0] === MEDIA_PREFIX) {
    const file = await resolveInside(roots.mediaRoot, '/' + segments.slice(1).join('/'), MEDIA_TYPES)
    return file === null ? notFound() : serveFile(request, file.path, file.type)
  }

  const rel = segments.length === 0 ? 'index.html' : segments.join('/')
  const file = await resolveInside(roots.uiRoot, join(roots.uiRoot, rel), UI_TYPES)
  return file === null ? notFound() : serveFile(request, file.path, file.type)
}

// The real path of `candidate` if it's a regular file with an allowed extension inside
// `root` once symlinks are resolved, else null
export async function resolveInside(
  root: string,
  candidate: string,
  types: Record<string, string>
): Promise<{ path: string; type: string } | null> {
  if (!isAbsolute(candidate)) return null
  const type = types[extname(candidate).toLowerCase()]
  if (type === undefined) return null
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(resolve(root)), fs.realpath(resolve(candidate))])
    const rel = relative(realRoot, realFile)
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
    // The extension check again, on what the symlinks really point at
    if (types[extname(realFile).toLowerCase()] !== type) return null
    const stat = await fs.stat(realFile)
    if (!stat.isFile()) return null
    return { path: realFile, type }
  } catch {
    return null
  }
}

// RFC 9110 single byte range. null: serve the whole file (no header, or one we don't
// handle, like several ranges); 'unsatisfiable': 416.
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, startText, endText] = match
  if (startText === '' && endText === '') return null
  if (startText === '') {
    // Suffix: the last N bytes
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix)) return null
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  const last = endText === '' ? null : Number(endText)
  // An invalid range (end before start, absurd numbers) is ignored, per RFC 9110
  if (!Number.isSafeInteger(start) || (last !== null && (!Number.isSafeInteger(last) || last < start))) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

async function serveFile(request: Request, path: string, type: string): Promise<Response> {
  let size: number
  try {
    size = (await fs.stat(path)).size
  } catch {
    return notFound()
  }
  const headers = new Headers({
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  })
  if (type.startsWith('text/html')) headers.set('Content-Security-Policy', PAGE_CSP)
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  headers.set('Content-Length', String(length))
  if (range !== null) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const body =
    request.method === 'HEAD' || length === 0
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream<Uint8Array>)
  return new Response(body, { status: range === null ? 200 : 206, headers })
}

function notFound(status = 404): Response {
  return new Response(null, { status })
}
