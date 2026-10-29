// Short call chimes synthesized with Web Audio: no audio files to download.

let ctx: AudioContext | null = null
let sink = ''

const C5 = 523.25
const E5 = 659.25
const G5 = 783.99

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** Follows the chosen audio output (Chrome 110+; elsewhere the system output). */
export function setSoundOutput(deviceId: string) {
  sink = deviceId
  const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
  c?.setSinkId?.(sink).catch(() => {})
}

/** Plays notes one after another, each a soft sine "pling". */
function chime(notes: number[]) {
  const c = context()
  if (!c) return
  if (sink) setSoundOutput(sink)
  const start = c.currentTime + 0.02
  notes.forEach((freq, i) => {
    const t = start + i * 0.09
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
    osc.connect(gain).connect(c.destination)
    osc.start(t)
    osc.stop(t + 0.26)
  })
}

export const sounds = {
  /** Someone joined the call you're in. */
  join: () => chime([C5, G5]),
  /** Someone left the call you're in. */
  leave: () => chime([G5, C5]),
  /** You joined a call. */
  selfJoin: () => chime([C5, E5, G5]),
  /** You left a call. */
  selfLeave: () => chime([G5, E5, C5]),
}
