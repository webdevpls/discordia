/** A screen or window the desktop app can capture. */
export type CaptureSource = {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** data: URLs; icon is only present for windows. */
  thumbnail: string
  icon?: string
}

/** Exposed by the Electron app's preload script; undefined in a regular browser. */
type DesktopBridge = {
  platform: string
  /** Whether the desktop app can capture system audio with the screen. */
  systemAudio: boolean
  getSources(): Promise<CaptureSource[]>
  /** Picks what the next getDisplayMedia call captures, skipping the system picker. */
  selectSource(id: string, audio: boolean): Promise<void>
}

export const desktop = (window as unknown as { discordia?: DesktopBridge }).discordia

const ua = navigator.userAgent
const firefox = /firefox/i.test(ua)
const safari = !firefox && /safari/i.test(ua) && !/chrome|chromium|crios|edg/i.test(ua)

/** Chromium honours displaySurface/systemAudio hints; Safari and Firefox ignore them and never capture audio. */
export const browserCapture = {
  hints: !safari && !firefox,
  audio: !safari && !firefox,
  name: safari ? 'Safari' : firefox ? 'Firefox' : 'navegador',
}
