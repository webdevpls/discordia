import type { Suppressed } from './noise'
import type { Source } from './types'

type Send = (t: string, d?: unknown) => void

export type Level = 'good' | 'fair' | 'poor'
export type Quality = { level: Level; rtt: number | null; loss: number }

export type SessionEvents = {
  /** key is "userId|source"; stream null means it ended. */
  onStream(key: string, stream: MediaStream | null): void
  onSpeaking(userId: number, speaking: boolean): void
  onQuality(q: Quality): void
}

// Outgoing video per connection level. The SFU forwards as-is, so this is also
// what peers download. Audio is never degraded: it gets network priority instead.
type Enc = { maxBitrate: number; scaleResolutionDownBy: number; maxFramerate: number }
const ENCODINGS: Record<'camera' | 'screen', Record<Level, Enc>> = {
  camera: {
    good: { maxBitrate: 500_000, scaleResolutionDownBy: 1, maxFramerate: 15 },
    fair: { maxBitrate: 250_000, scaleResolutionDownBy: 1.5, maxFramerate: 12 },
    poor: { maxBitrate: 120_000, scaleResolutionDownBy: 2, maxFramerate: 8 },
  },
  screen: {
    good: { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 },
    fair: { maxBitrate: 1_200_000, scaleResolutionDownBy: 1, maxFramerate: 15 },
    poor: { maxBitrate: 500_000, scaleResolutionDownBy: 1.5, maxFramerate: 8 },
  },
}

// 15fps is plenty for talking heads and costs ~40% less to encode/decode than 24fps.
const CAMERA: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } }
const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

/** "" means the system default device. With RNNoise on, the browser's own suppressor is skipped to avoid double processing. */
function micConstraints(deviceId: string, rnnoise = false): MediaTrackConstraints {
  const base = rnnoise ? { ...MIC, noiseSuppression: false } : MIC
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base
}

const RANK: Record<Level, number> = { good: 0, fair: 1, poor: 2 }

export function streamKey(userId: number, src: Source) {
  return `${userId}|${src}`
}

/**
 * Puts H.264 Constrained Baseline first: browsers encode/decode it in hardware
 * (VideoToolbox on Macs, GPU elsewhere), which takes most video work off the CPU.
 * VP8 stays as fallback.
 */
function preferH264(t: RTCRtpTransceiver) {
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs
  if (!codecs || !t.setCodecPreferences) return
  const rank = (c: RTCRtpCodec) => {
    const fmtp = c.sdpFmtpLine ?? ''
    if (c.mimeType === 'video/H264' && fmtp.includes('packetization-mode=1')) return fmtp.includes('profile-level-id=42e01f') ? 0 : 1
    if (c.mimeType === 'video/VP8') return 2
    return 3
  }
  try {
    t.setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)))
  } catch {
    /* keep browser defaults */
  }
}

/**
 * One voice-channel connection. "pub" sends our media to the SFU (we offer),
 * "sub" receives everyone else's (the SFU offers). Two PCs = no offer glare.
 */
export class VoiceSession {
  readonly channelId: number
  private selfId: number
  private send: Send
  private ev: SessionEvents
  private ice: RTCIceServer[]

  private pub: RTCPeerConnection
  private sub: RTCPeerConnection | null = null
  private tx: Partial<Record<Source, RTCRtpTransceiver>> = {}
  private tracks: Partial<Record<Source, MediaStreamTrack>> = {}

  private pubBusy = false
  private pubPending = false
  private pubCands: RTCIceCandidateInit[] = []
  private subCands: RTCIceCandidateInit[] = []
  private subQueue: Promise<void> = Promise.resolve()
  private closed = false
  private speaking: SpeakingDetector

  private micDevice = ''
  private rnnoise = false
  private micPipeline: Suppressed | null = null

  private level: Level = 'good'
  private pending: { level: Level; count: number } | null = null
  private samples = 0
  private lastIn = { lost: 0, recv: 0 }
  private qualityTimer: number

  constructor(channelId: number, selfId: number, ice: RTCIceServer[], send: Send, ev: SessionEvents) {
    this.channelId = channelId
    this.selfId = selfId
    this.ice = ice
    this.send = send
    this.ev = ev
    this.speaking = new SpeakingDetector(ev.onSpeaking)

    this.pub = new RTCPeerConnection({ iceServers: ice })
    this.pub.onicecandidate = (e) => e.candidate && send('rtc.pub.candidate', e.candidate.toJSON())
    this.qualityTimer = window.setInterval(() => void this.sampleQuality(), 2000)
  }

  /** Grabs the microphone. Returns false if permission was denied (listen-only). */
  async start(deviceId = '', rnnoise = false): Promise<boolean> {
    try {
      await this.useMic(deviceId, rnnoise)
      return !this.closed
    } catch {
      return false
    }
  }

  /** Opens the mic (optionally through RNNoise) and makes it the outgoing mic track. */
  private async useMic(deviceId: string, rnnoise: boolean) {
    const md = navigator.mediaDevices
    const stream = await md.getUserMedia({ audio: micConstraints(deviceId, rnnoise) }).catch((err) => {
      // A saved device that was unplugged: fall back to the default one.
      if (deviceId && (err as DOMException)?.name === 'OverconstrainedError') return md.getUserMedia({ audio: micConstraints('', rnnoise) })
      throw err
    })
    const raw = stream.getAudioTracks()[0]
    if (this.closed) {
      raw.stop()
      return
    }

    let pipeline: Suppressed = { track: raw, dispose: () => raw.stop() }
    if (rnnoise) {
      try {
        const { suppressNoise } = await import('./noise')
        pipeline = await suppressNoise(raw)
      } catch (err) {
        // No AudioWorklet/WASM: keep the browser's suppressor instead of going silent.
        console.warn('rnnoise indisponível', err)
        raw.applyConstraints({ ...raw.getConstraints(), noiseSuppression: true }).catch(() => {})
        rnnoise = false
      }
    }
    if (this.closed) {
      pipeline.dispose()
      return
    }
    // The processed track never "ends" on its own, so follow the device.
    raw.addEventListener('ended', () => {
      if (this.tracks.mic === pipeline.track) void this.setSource('mic', null).then(() => this.onEnded?.('mic'))
    })

    const prev = this.micPipeline
    const enabled = this.tracks.mic?.enabled ?? true
    pipeline.track.enabled = enabled
    this.micDevice = deviceId
    this.rnnoise = rnnoise
    this.micPipeline = pipeline
    await this.setSource('mic', pipeline.track)
    prev?.dispose()
  }

  /** Whether RNNoise is actually running (it can fall back to the browser's suppressor). */
  get noiseSuppression() {
    return this.rnnoise
  }

  has(src: Source) {
    return !!this.tracks[src]
  }

  setMuted(muted: boolean) {
    const mic = this.tracks.mic
    if (mic) mic.enabled = !muted
  }

  /** Swaps the microphone mid-call, keeping the mute state. */
  async switchMic(deviceId: string) {
    await this.useMic(deviceId, this.rnnoise)
  }

  /** Turns RNNoise on/off mid-call; returns whether it ended up on. */
  async setNoiseSuppression(on: boolean): Promise<boolean> {
    if (this.tracks.mic) await this.useMic(this.micDevice, on)
    else this.rnnoise = on
    return this.rnnoise
  }

  async toggleCamera(): Promise<boolean> {
    if (this.tracks.camera) {
      await this.setSource('camera', null)
      return false
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA })
    await this.setSource('camera', stream.getVideoTracks()[0])
    return true
  }

  async toggleScreen(): Promise<boolean> {
    if (this.tracks.screen) {
      await this.setSource('screen', null)
      await this.setSource('screen-audio', null)
      return false
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: true })
    const video = stream.getVideoTracks()[0]
    video.contentHint = 'detail'
    await this.setSource('screen', video)
    const audio = stream.getAudioTracks()[0]
    if (audio) await this.setSource('screen-audio', audio)
    return true
  }

  /** Starts, swaps or stops one outgoing source, reusing its transceiver. */
  async setSource(src: Source, track: MediaStreamTrack | null) {
    if (this.closed) {
      track?.stop()
      return
    }
    const prev = this.tracks[src]
    if (prev && prev !== track) prev.stop()
    if (src === 'mic' && !track) {
      this.micPipeline?.dispose()
      this.micPipeline = null
    }

    if (track) {
      this.tracks[src] = track
      track.addEventListener('ended', () => {
        if (this.tracks[src] === track) void this.setSource(src, null).then(() => this.onEnded?.(src))
      })
    } else {
      delete this.tracks[src]
    }

    // A live transceiver just swaps tracks (e.g. a new mic). Once a source stops,
    // its transceiver is retired: the SFU (Pion) ends the remote track when the
    // m-line goes inactive and never fires OnTrack again for it, so restarting
    // the source (sharing the screen a second time) needs a fresh transceiver.
    const t = this.tx[src]
    if (track && t) {
      await t.sender.replaceTrack(track)
    } else if (track) {
      const created = this.pub.addTransceiver(track, { direction: 'sendonly' })
      if (track.kind === 'video') preferH264(created)
      this.tx[src] = created
    } else if (t) {
      await t.sender.replaceTrack(null)
      t.direction = 'inactive'
      delete this.tx[src]
    }

    if (src !== 'screen-audio') {
      this.ev.onStream(streamKey(this.selfId, src), track ? new MediaStream([track]) : null)
    }
    if (src === 'mic') {
      if (track) this.speaking.add(this.selfId, new MediaStream([track]))
      else this.speaking.remove(this.selfId)
    }
    await this.negotiatePub()
  }

  /** Fired when the browser ends a track on its own (e.g. "Stop sharing"). */
  onEnded?: (src: Source) => void

  private async negotiatePub() {
    if (this.pub.getTransceivers().length === 0) return
    if (this.pubBusy) {
      this.pubPending = true
      return
    }
    this.pubBusy = true
    try {
      const offer = await this.pub.createOffer()
      await this.pub.setLocalDescription(offer)
      const sources: Record<string, Source> = {}
      for (const [src, t] of Object.entries(this.tx) as [Source, RTCRtpTransceiver][]) {
        if (this.tracks[src] && t.mid) sources[t.mid] = src
      }
      this.send('rtc.pub.offer', { sdp: this.pub.localDescription!.sdp, sources })
    } catch (err) {
      console.error('pub offer', err)
      this.pubBusy = false
    }
  }

  async onPubAnswer(sdp: string) {
    if (this.closed) return
    try {
      await this.pub.setRemoteDescription({ type: 'answer', sdp })
      for (const c of this.pubCands.splice(0)) await this.pub.addIceCandidate(c).catch(() => {})
      this.applyEncodings()
    } catch (err) {
      console.error('pub answer', err)
    }
    this.pubBusy = false
    if (this.pubPending) {
      this.pubPending = false
      void this.negotiatePub()
    }
  }

  onPubCandidate(c: RTCIceCandidateInit) {
    if (!this.pub.remoteDescription) this.pubCands.push(c)
    else this.pub.addIceCandidate(c).catch(() => {})
  }

  /** Applies the current level's video caps, and keeps voice first in line on the network. */
  private applyEncodings() {
    for (const src of ['mic', 'camera', 'screen'] as const) {
      const sender = this.tx[src]?.sender
      if (!sender?.track) continue
      const p = sender.getParameters()
      if (!p.encodings?.length) p.encodings = [{}]
      const e = p.encodings[0]
      if (src === 'mic') {
        e.priority = 'high'
        e.networkPriority = 'high'
      } else {
        Object.assign(e, ENCODINGS[src][this.level])
      }
      sender.setParameters(p).catch(() => {})
    }
  }

  // --- connection quality ---

  /**
   * Every 2s: RTT, packet loss both ways and (when sending video) the browser's
   * bandwidth estimate. A level change needs 2 bad samples to degrade and 3 good
   * ones to recover, so a single hiccup doesn't make video flap.
   */
  private async sampleQuality() {
    if (this.closed || this.pub.connectionState !== 'connected') return
    let upLoss = 0
    const report = await this.pub.getStats()
    // The pair actually carrying media is the transport's selected one; "nominated"
    // can match stale pairs from earlier ICE checks.
    let pair: any
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId)
    })
    if (!pair) report.forEach((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && (pair ??= s))
    // Ping to the server: ICE consent checks give currentRoundTripTime; RTCP receiver
    // reports (remote-inbound-rtp.roundTripTime) are the fallback when it's missing.
    let rtt: number | null = pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null
    report.forEach((s) => {
      if (s.type === 'remote-inbound-rtp' && s.fractionLost != null) upLoss = Math.max(upLoss, s.fractionLost)
      if (s.type === 'remote-inbound-rtp' && rtt === null && s.roundTripTime != null) rtt = s.roundTripTime * 1000
    })

    let downLoss = 0
    if (this.sub) {
      let lost = 0
      let recv = 0
      ;(await this.sub.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp') {
          lost += Math.max(0, s.packetsLost ?? 0)
          recv += s.packetsReceived ?? 0
        }
      })
      const dl = lost - this.lastIn.lost
      const dr = recv - this.lastIn.recv
      if (dl + dr > 0) downLoss = Math.max(0, dl) / (Math.max(0, dl) + Math.max(0, dr))
      this.lastIn = { lost, recv }
    }

    // Only loss and RTT count. The browser's bandwidth estimate starts low whenever
    // video turns on after an audio-only stretch (and stays low once we cap the
    // bitrate), which looked like a weak link on perfect networks. The browser
    // already adapts its send rate under our cap on its own.
    const loss = Math.max(upLoss, downLoss)
    let seen: Level = 'good'
    if (loss >= 0.08 || (rtt ?? 0) >= 500) seen = 'poor'
    else if (loss >= 0.03 || (rtt ?? 0) >= 250) seen = 'fair'
    this.samples++

    if (seen !== this.level && this.samples > 2) {
      const need = RANK[seen] > RANK[this.level] ? 2 : 3
      this.pending = this.pending?.level === seen ? { level: seen, count: this.pending.count + 1 } : { level: seen, count: 1 }
      if (this.pending.count >= need) {
        this.level = seen
        this.pending = null
        this.applyEncodings()
      }
    } else {
      this.pending = null
    }
    this.ev.onQuality({ level: this.level, rtt: rtt === null ? null : Math.round(rtt * 10) / 10, loss })
  }

  // --- receiving ---

  private ensureSub(): RTCPeerConnection {
    if (this.sub) return this.sub
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    pc.onicecandidate = (e) => e.candidate && this.send('rtc.sub.candidate', e.candidate.toJSON())
    pc.ontrack = (e) => {
      const remote = e.streams[0]
      if (!remote) return
      const key = remote.id // "userId|source", set by the SFU
      const [uid, src] = key.split('|')
      const stream = new MediaStream([e.track])
      this.ev.onStream(key, stream)
      if (src === 'mic') this.speaking.add(Number(uid), stream)

      const gone = () => {
        this.ev.onStream(key, null)
        if (src === 'mic') this.speaking.remove(Number(uid))
      }
      remote.onremovetrack = (r) => r.track === e.track && gone()
      e.track.onended = gone
    }
    this.sub = pc
    return pc
  }

  onSubOffer(sdp: string) {
    this.subQueue = this.subQueue
      .then(async () => {
        if (this.closed) return
        const pc = this.ensureSub()
        await pc.setRemoteDescription({ type: 'offer', sdp })
        for (const c of this.subCands.splice(0)) await pc.addIceCandidate(c).catch(() => {})
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this.send('rtc.sub.answer', { sdp: answer.sdp })
      })
      .catch((err) => console.error('sub offer', err))
  }

  onSubCandidate(c: RTCIceCandidateInit) {
    this.subQueue = this.subQueue.then(async () => {
      if (!this.sub?.remoteDescription) this.subCands.push(c)
      else await this.sub.addIceCandidate(c).catch(() => {})
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.qualityTimer)
    Object.values(this.tracks).forEach((t) => t?.stop())
    this.tracks = {}
    this.micPipeline?.dispose()
    this.micPipeline = null
    this.pub.close()
    this.sub?.close()
    this.speaking.close()
  }
}

/** Cheap voice-activity detection: one AudioContext, RMS polled ~8×/s. */
class SpeakingDetector {
  private ctx: AudioContext | null = null
  private entries = new Map<number, { node: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer>; on: boolean; quiet: number }>()
  private timer: number | undefined
  private cb: (uid: number, speaking: boolean) => void

  constructor(cb: (uid: number, speaking: boolean) => void) {
    this.cb = cb
  }

  add(uid: number, stream: MediaStream) {
    this.remove(uid)
    this.ctx ??= new AudioContext()
    void this.ctx.resume()
    const node = this.ctx.createMediaStreamSource(stream)
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 512
    node.connect(analyser)
    this.entries.set(uid, { node, analyser, buf: new Uint8Array(analyser.fftSize), on: false, quiet: 0 })
    this.timer ??= window.setInterval(() => this.tick(), 120)
  }

  remove(uid: number) {
    const e = this.entries.get(uid)
    if (!e) return
    e.node.disconnect()
    this.entries.delete(uid)
    if (e.on) this.cb(uid, false)
  }

  private tick() {
    for (const [uid, e] of this.entries) {
      e.analyser.getByteTimeDomainData(e.buf)
      let sum = 0
      for (let i = 0; i < e.buf.length; i++) {
        const v = (e.buf[i] - 128) / 128
        sum += v * v
      }
      const loud = Math.sqrt(sum / e.buf.length) > 0.02
      // Hang time avoids flicker between words.
      e.quiet = loud ? 0 : e.quiet + 1
      const on = loud || (e.on && e.quiet < 3)
      if (on !== e.on) {
        e.on = on
        this.cb(uid, on)
      }
    }
  }

  close() {
    for (const uid of [...this.entries.keys()]) this.remove(uid)
    clearInterval(this.timer)
    void this.ctx?.close()
  }
}
