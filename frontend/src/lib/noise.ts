import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

// The ~100 KB model is fetched once and shared by every pipeline.
let wasm: Promise<ArrayBuffer> | null = null

export type Suppressed = { track: MediaStreamTrack; dispose: () => void }

/**
 * Runs a mic track through RNNoise (a small recurrent neural net, ~1–2% of a
 * core) on an AudioWorklet and returns the cleaned track. Removes keyboard,
 * fans, traffic and other steady or impulsive noise while keeping speech.
 */
export async function suppressNoise(raw: MediaStreamTrack): Promise<Suppressed> {
  wasm ??= loadRnnoise({ url: wasmUrl, simdUrl }).catch((err) => {
    wasm = null
    throw err
  })
  // RNNoise is trained on 48 kHz frames.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
  try {
    const [binary] = await Promise.all([wasm, ctx.audioWorklet.addModule(workletUrl)])
    const source = ctx.createMediaStreamSource(new MediaStream([raw]))
    const rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 })
    const out = ctx.createMediaStreamDestination()
    source.connect(rnnoise).connect(out)
    await ctx.resume()
    const track = out.stream.getAudioTracks()[0]
    return {
      track,
      dispose: () => {
        source.disconnect()
        rnnoise.disconnect()
        rnnoise.destroy()
        track.stop()
        raw.stop()
        void ctx.close()
      },
    }
  } catch (err) {
    void ctx.close()
    throw err
  }
}
