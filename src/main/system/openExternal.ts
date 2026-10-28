import { shell } from 'electron'

// Links leave the app only as https, in the default browser
export function openExternalUrl(url: string): Promise<void> {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return Promise.reject(new Error(`Not a valid link: ${url}`))
  }
  if (protocol !== 'https:') return Promise.reject(new Error(`Only https links can be opened: ${url}`))
  return shell.openExternal(url)
}
