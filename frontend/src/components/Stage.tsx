import { HeadphoneOff, Headphones, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, SlidersHorizontal, Video, VideoOff, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { streamKey } from '../lib/rtc'
import type { Channel, VoiceUser } from '../lib/types'
import { joinVoice, leaveVoice, setVideoWanted, setVolume, toggleCamera, toggleDeafen, toggleMute, toggleScreen, useStore } from '../store'
import { Avatar } from './Avatar'

type Tile = { id: string; user: VoiceUser; kind: 'user' | 'screen' }
type Menu = { tile: Tile; x: number; y: number }
type TileEvents = { onClick: () => void; onMenu: (tile: Tile, x: number, y: number) => void }

export function Stage({ channel }: { channel: Channel }) {
  const voice = useStore((s) => s.voice)
  const users = useStore((s) => s.voiceStates[channel.id])
  const me = useStore((s) => s.me)
  const [focus, setFocus] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const here = voice?.channelId === channel.id

  // Ask the SFU only for videos that have a tile on screen. Leaving this view
  // (e.g. reading a text channel mid-call) drops all incoming video.
  const wanted = here
    ? (users ?? [])
        .filter((u) => u.user_id !== me?.id)
        .flatMap((u) => [u.camera && streamKey(u.user_id, 'camera'), u.screen && streamKey(u.user_id, 'screen')])
        .filter((k): k is string => !!k)
        .join(',')
    : ''
  useEffect(() => {
    setVideoWanted(wanted ? wanted.split(',') : [])
  }, [wanted])
  useEffect(() => () => setVideoWanted([]), [])

  if (!here) {
    return (
      <div className="stage">
        <div className="empty">
          <h3>{channel.name}</h3>
          <span>{users?.length ? `${users.length} pessoa(s) na chamada` : 'Ninguém na chamada ainda'}</span>
          <button className="btn" onClick={() => joinVoice(channel)}>
            Entrar na chamada
          </button>
        </div>
      </div>
    )
  }

  const tiles: Tile[] = []
  for (const u of users ?? []) {
    if (u.screen) tiles.push({ id: `${u.user_id}:screen`, user: u, kind: 'screen' })
    tiles.push({ id: `${u.user_id}:user`, user: u, kind: 'user' })
  }
  const focused = tiles.find((t) => t.id === focus)
  const toggleFocus = (id: string) => setFocus((f) => (f === id ? null : id))
  const openMenu = (tile: Tile, x: number, y: number) => setMenu({ tile, x, y })

  return (
    <div className="stage">
      {focused ? (
        <div className="focus">
          <TileView tile={focused} onClick={() => toggleFocus(focused.id)} onMenu={openMenu} />
          <div className="strip">
            {tiles
              .filter((t) => t !== focused)
              .map((t) => (
                <TileView key={t.id} tile={t} onClick={() => toggleFocus(t.id)} onMenu={openMenu} />
              ))}
          </div>
        </div>
      ) : (
        <Grid tiles={tiles} onPick={toggleFocus} onMenu={openMenu} />
      )}
      <Controls />
      {menu && (
        <TileMenu
          key={menu.tile.id}
          menu={menu}
          focused={focus === menu.tile.id}
          onFocus={() => toggleFocus(menu.tile.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function Grid({ tiles, onPick, onMenu }: { tiles: Tile[]; onPick: (id: string) => void; onMenu: TileEvents['onMenu'] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ cols: 1, width: 0 })

  // Pick the column count that makes 16:9 tiles as large as possible.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      const { width, height } = el.getBoundingClientRect()
      const n = Math.max(1, tiles.length)
      let best = { cols: 1, width: 0 }
      for (let c = 1; c <= n; c++) {
        const rows = Math.ceil(n / c)
        const w = Math.min((width - (c - 1) * 10) / c, ((height - (rows - 1) * 10) / rows) * (16 / 9))
        if (w > best.width) best = { cols: c, width: Math.floor(w) }
      }
      setLayout(best)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tiles.length])

  return (
    <div className="grid" ref={ref} style={{ gridTemplateColumns: `repeat(${layout.cols}, ${layout.width ? `${layout.width}px` : 'minmax(0, 1fr)'})`, justifyContent: 'center' }}>
      {tiles.map((t) => (
        <TileView key={t.id} tile={t} onClick={() => onPick(t.id)} onMenu={onMenu} />
      ))}
    </div>
  )
}

function TileView({ tile, onClick, onMenu }: { tile: Tile } & TileEvents) {
  const { user, kind } = tile
  const me = useStore((s) => s.me)
  const name = useStore((s) => s.users[user.user_id]?.username ?? '…')
  const stream = useStore((s) => s.streams[streamKey(user.user_id, kind === 'screen' ? 'screen' : 'camera')])
  const speaking = useStore((s) => !!s.speaking[user.user_id] && !user.muted)
  const self = user.user_id === me?.id
  const showVideo = kind === 'screen' ? !!stream : user.camera && !!stream

  // Right-click anywhere, or left-click the options button, opens the tile's settings.
  const onContextMenu = (e: MouseEvent) => {
    if (self) return
    e.preventDefault()
    onMenu(tile, e.clientX, e.clientY)
  }
  const openFromButton = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onMenu(tile, r.right, r.bottom + 6)
  }

  return (
    <div className={`tile ${kind === 'user' && speaking ? 'speaking' : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      {showVideo ? (
        <VideoEl stream={stream!} className={kind === 'screen' ? 'contain' : self ? 'mirror' : ''} />
      ) : (
        <Avatar id={user.user_id} name={name} size={72} />
      )}
      {!self && (
        <button className="tile-opts" title={kind === 'screen' ? 'Configurações da transmissão' : `Configurações de ${name}`} onClick={openFromButton}>
          <SlidersHorizontal size={16} />
        </button>
      )}
      <div className="tag">
        {kind === 'screen' ? <MonitorUp size={13} /> : user.deafened ? <HeadphoneOff size={13} /> : user.muted ? <MicOff size={13} /> : null}
        <span>{kind === 'screen' ? `Tela de ${name}` : name}</span>
      </div>
    </div>
  )
}

/** Settings popover for someone else's tile: their voice or stream volume, plus focus. */
function TileMenu({ menu, focused, onFocus, onClose }: { menu: Menu; focused: boolean; onFocus: () => void; onClose: () => void }) {
  const { tile } = menu
  const screen = tile.kind === 'screen'
  const uid = tile.user.user_id
  const key = streamKey(uid, screen ? 'screen-audio' : 'mic')
  const name = useStore((s) => s.users[uid]?.username ?? '…')
  const hasAudio = useStore((s) => !!s.streams[key])
  const volume = useStore((s) => s.volumes[key] ?? 1)
  const ref = useRef<HTMLDivElement>(null)
  const lastAudible = useRef(volume || 1)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  useEffect(() => {
    if (volume > 0) lastAudible.current = volume
  }, [volume])

  // Keep the popover inside the viewport (16px gutter); a button anchor opens leftwards.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = Math.min(Math.max(16, menu.x - (screen || menu.x + width > innerWidth - 16 ? width : 0)), innerWidth - width - 16)
    const top = Math.min(Math.max(16, menu.y), innerHeight - height - 16)
    setPos({ left, top })
  }, [menu.x, menu.y, screen])

  useEffect(() => {
    const onDown = (e: Event) => !ref.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const pct = Math.round(volume * 100)

  return (
    <div className="tile-menu" ref={ref} role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      <span className="label">{screen ? `Tela de ${name}` : name}</span>
      <div className="row-label">
        <span>{screen ? 'Volume da transmissão' : 'Volume do usuário'}</span>
        <span className="pct">{hasAudio ? `${pct}%` : '—'}</span>
      </div>
      {hasAudio ? (
        <div className="vol-row">
          <button title={volume === 0 ? 'Ativar som' : 'Silenciar'} onClick={() => setVolume(key, volume === 0 ? lastAudible.current : 0)}>
            <Icon size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            autoFocus
            aria-label={screen ? 'Volume da transmissão' : `Volume de ${name}`}
            style={{ '--fill': `${pct}%` } as CSSProperties}
            onChange={(e) => setVolume(key, Number(e.target.value) / 100)}
          />
        </div>
      ) : (
        <p className="hint">
          {screen
            ? 'Esta tela foi compartilhada sem áudio. Para enviar som, compartilhe uma aba do Chrome e marque “Compartilhar áudio da aba”.'
            : `${name} está sem microfone.`}
        </p>
      )}
      {hasAudio && (
        <button className="item" role="menuitemcheckbox" aria-checked={volume === 0} onClick={() => setVolume(key, volume === 0 ? lastAudible.current : 0)}>
          <span>{screen ? 'Silenciar transmissão' : 'Silenciar usuário'}</span>
          <i className={`switch ${volume === 0 ? 'on' : ''}`} aria-hidden />
        </button>
      )}
      <button
        className="item"
        onClick={() => {
          onFocus()
          onClose()
        }}
      >
        <span>{focused ? 'Voltar para a grade' : 'Ampliar'}</span>
        {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </div>
  )
}

function VideoEl({ stream, className }: { stream: MediaStream; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} className={className} autoPlay playsInline muted />
}

function Controls() {
  const v = useStore((s) => s.voice)!
  return (
    <div className="controls">
      <button className={`ctrl ${v.muted ? 'off' : ''}`} title={v.muted ? 'Ativar microfone' : 'Silenciar'} onClick={toggleMute}>
        {v.muted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>
      <button className={`ctrl ${v.deafened ? 'off' : ''}`} title={v.deafened ? 'Ativar áudio' : 'Ensurdecer'} onClick={toggleDeafen}>
        {v.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
      </button>
      <button className={`ctrl ${v.camera ? 'on' : ''}`} title={v.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={toggleCamera}>
        {v.camera ? <Video size={20} /> : <VideoOff size={20} />}
      </button>
      <button className={`ctrl ${v.screen ? 'on' : ''}`} title={v.screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={toggleScreen}>
        <MonitorUp size={20} />
      </button>
      <button className="ctrl leave" title="Sair da chamada" onClick={leaveVoice}>
        <PhoneOff size={20} />
      </button>
    </div>
  )
}

/** Plays every remote audio stream; always mounted while in a call. */
export function AudioSink() {
  const streams = useStore((s) => s.streams)
  const me = useStore((s) => s.me)
  const deafened = useStore((s) => !!s.voice?.deafened)
  const output = useStore((s) => s.audioOutput)
  const volumes = useStore((s) => s.volumes)
  const audio = Object.entries(streams).filter(([key]) => {
    const [uid, src] = key.split('|')
    return Number(uid) !== me?.id && (src === 'mic' || src === 'screen-audio')
  })
  return (
    <div className="audio-sink">
      {audio.map(([key, stream]) => {
        const volume = volumes[key] ?? 1
        return <AudioEl key={key} id={key} stream={stream} muted={deafened} output={output} volume={volume} />
      })}
    </div>
  )
}

function AudioEl({ id, stream, muted, output, volume }: { id: string; stream: MediaStream; muted: boolean; output: string; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.volume = volume
  }, [volume])
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  useEffect(() => {
    // Not in every browser (Safari < 18.4); those just use the system output.
    ref.current?.setSinkId?.(output).catch(() => {})
  }, [output])
  return <audio ref={ref} data-stream={id} autoPlay muted={muted} />
}
