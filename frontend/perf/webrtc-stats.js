// Medidor WebRTC — funciona igual no Discordia e no Google Meet.
//
// 1. Abra o DevTools (⌥⌘J) ANTES de entrar na chamada e cole este arquivo inteiro.
// 2. Entre na chamada, ligue câmera (e tela, se quiser comparar isso).
// 3. Espere ~30s e rode:  await rtcReport()      (mede por 10s e imprime uma tabela)
//
// Para CPU/memória da aba, use o Gerenciador de tarefas do Chrome (⇧Esc).
;(() => {
  if (window.__rtcPCs) return console.log('medidor já instalado')
  const pcs = (window.__rtcPCs = new Set())
  const Orig = window.RTCPeerConnection
  window.RTCPeerConnection = function (...args) {
    const pc = new Orig(...args)
    pcs.add(pc)
    pc.addEventListener('connectionstatechange', () => pc.connectionState === 'closed' && pcs.delete(pc))
    return pc
  }
  window.RTCPeerConnection.prototype = Orig.prototype
  Object.setPrototypeOf(window.RTCPeerConnection, Orig)

  async function snapshot() {
    const all = []
    for (const pc of pcs) if (pc.connectionState !== 'closed') all.push(...(await pc.getStats()).values())
    return all
  }

  function sum(list, type, kind, field) {
    return list.filter((s) => s.type === type && (s.kind ?? s.mediaType) === kind).reduce((a, s) => a + (s[field] ?? 0), 0)
  }

  window.rtcReport = async function (seconds = 10) {
    const a = await snapshot()
    await new Promise((r) => setTimeout(r, seconds * 1000))
    const b = await snapshot()
    const rate = (type, kind, field) => ((sum(b, type, kind, field) - sum(a, type, kind, field)) * 8) / seconds / 1000
    const codecs = new Map(b.filter((s) => s.type === 'codec').map((s) => [s.id, s.mimeType]))

    const outV = b.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video' && s.frameWidth)
    const inV = b.filter((s) => s.type === 'inbound-rtp' && s.kind === 'video' && s.frameWidth)
    const pair = b.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
    const lost = sum(b, 'inbound-rtp', 'video', 'packetsLost') + sum(b, 'inbound-rtp', 'audio', 'packetsLost')
    const recv = sum(b, 'inbound-rtp', 'video', 'packetsReceived') + sum(b, 'inbound-rtp', 'audio', 'packetsReceived')
    const enc = outV.reduce((x, s) => x + (s.totalEncodeTime ?? 0), 0) / Math.max(1, outV.reduce((x, s) => x + (s.framesEncoded ?? 0), 0))
    const dec = inV.reduce((x, s) => x + (s.totalDecodeTime ?? 0), 0) / Math.max(1, inV.reduce((x, s) => x + (s.framesDecoded ?? 0), 0))

    const report = {
      'PeerConnections': [...pcs].filter((p) => p.connectionState !== 'closed').length,
      'Upload áudio (kbps)': Math.round(rate('outbound-rtp', 'audio', 'bytesSent')),
      'Upload vídeo (kbps)': Math.round(rate('outbound-rtp', 'video', 'bytesSent')),
      'Download áudio (kbps)': Math.round(rate('inbound-rtp', 'audio', 'bytesReceived')),
      'Download vídeo (kbps)': Math.round(rate('inbound-rtp', 'video', 'bytesReceived')),
      'Vídeo enviado': outV.map((s) => `${s.frameWidth}x${s.frameHeight}@${Math.round(s.framesPerSecond ?? 0)} ${codecs.get(s.codecId) ?? ''}`).join(' | ') || '—',
      'Vídeo recebido': inV.map((s) => `${s.frameWidth}x${s.frameHeight}@${Math.round(s.framesPerSecond ?? 0)} ${codecs.get(s.codecId) ?? ''}`).join(' | ') || '—',
      'Camadas simulcast enviadas': outV.length,
      'Encoder': [...new Set(outV.map((s) => `${s.encoderImplementation ?? '?'}${s.powerEfficientEncoder ? ' (hardware)' : ''}`))].join(', ') || '—',
      'Decoder': [...new Set(inV.map((s) => `${s.decoderImplementation ?? '?'}${s.powerEfficientDecoder ? ' (hardware)' : ''}`))].join(', ') || '—',
      'Limitação de qualidade': [...new Set(outV.map((s) => s.qualityLimitationReason))].join(', ') || '—',
      'Encode por frame (ms)': +(enc * 1000).toFixed(2),
      'Decode por frame (ms)': +(dec * 1000).toFixed(2),
      'RTT (ms)': pair ? Math.round(pair.currentRoundTripTime * 1000) : '—',
      'Perda de pacotes (%)': recv ? +((lost / (lost + recv)) * 100).toFixed(2) : 0,
    }
    console.table(report)
    return report
  }
  console.log('medidor instalado — entre na chamada e depois rode: await rtcReport()')
})()
