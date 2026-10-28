import {
  Hash,
  Headphones,
  HeadphoneOff,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  ChevronUp,
  PhoneOff,
  Plus,
  Signal,
  SignalLow,
  SignalMedium,
  Trash2,
  UserPlus,
  Video,
  Volume2,
} from 'lucide-react'
import { useState } from 'react'
import type { Quality } from '../lib/rtc'
import type { Channel, ChannelKind } from '../lib/types'
import {
  deleteChannel,
  leaveGroup,
  leaveVoice,
  logout,
  openChannel,
  toast,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreen,
  useStore,
} from '../store'
import { Avatar } from './Avatar'
import { DeviceMenu } from './DeviceMenu'
import { CreateChannelModal, InviteModal } from './Modals'

export function Sidebar({ onOpen }: { onOpen: () => void }) {
  const groupId = useStore((s) => s.activeGroupId)
  const group = useStore((s) => s.groups.find((g) => g.id === s.activeGroupId))
  const detail = useStore((s) => (groupId ? s.details[groupId] : undefined))
  const me = useStore((s) => s.me)
  const [creating, setCreating] = useState<ChannelKind | null>(null)
  const [inviting, setInviting] = useState(false)

  const owner = !!group && group.owner_id === me?.id
  const text = detail?.channels.filter((c) => c.kind === 'text') ?? []
  const voice = detail?.channels.filter((c) => c.kind === 'voice') ?? []

  const open = (c: Channel) => {
    openChannel(c)
    onOpen()
  }

  const leave = async () => {
    if (!group) return
    try {
      await leaveGroup(group.id)
    } catch (err) {
      toast((err as Error).message)
    }
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <h2>{group?.name ?? 'Discordia'}</h2>
        {group && (
          <>
            <button className="icon-btn" title="Convidar pessoas" onClick={() => setInviting(true)}>
              <UserPlus size={17} />
            </button>
            {!owner && (
              <button className="icon-btn" title="Sair do grupo" onClick={leave}>
                <LogOut size={16} />
              </button>
            )}
          </>
        )}
      </header>

      <div className="channels">
        {!group && <p style={{ color: 'var(--muted)', padding: '0 8px' }}>Crie ou entre em um grupo usando o + ao lado.</p>}
        {group && (
          <>
            <Section title="Texto" canAdd={owner} onAdd={() => setCreating('text')} />
            {text.map((c) => (
              <ChannelRow key={c.id} channel={c} owner={owner} onOpen={open} />
            ))}
            <div style={{ height: 10 }} />
            <Section title="Voz" canAdd={owner} onAdd={() => setCreating('voice')} />
            {voice.map((c) => (
              <div key={c.id}>
                <ChannelRow channel={c} owner={owner} onOpen={open} />
                <VoiceUsers channelId={c.id} />
              </div>
            ))}
          </>
        )}
      </div>

      <VoiceBar onOpen={onOpen} />
      <MePanel />

      {creating && group && <CreateChannelModal groupId={group.id} kind={creating} onClose={() => setCreating(null)} />}
      {inviting && group && <InviteModal group={group} onClose={() => setInviting(false)} />}
    </aside>
  )
}

function Section({ title, canAdd, onAdd }: { title: string; canAdd: boolean; onAdd: () => void }) {
  return (
    <div className="section">
      <span className="label">{title}</span>
      {canAdd && (
        <button className="icon-btn" title="Criar canal" onClick={onAdd}>
          <Plus size={15} />
        </button>
      )}
    </div>
  )
}

function ChannelRow({ channel, owner, onOpen }: { channel: Channel; owner: boolean; onOpen: (c: Channel) => void }) {
  const active = useStore((s) => s.activeChannelId === channel.id)
  const Icon = channel.kind === 'text' ? Hash : Volume2
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await deleteChannel(channel.id)
    } catch (err) {
      toast((err as Error).message)
    }
  }
  return (
    <div role="button" tabIndex={0} className={`channel ${active ? 'active' : ''}`} onClick={() => onOpen(channel)} onKeyDown={(e) => e.key === 'Enter' && onOpen(channel)}>
      <Icon size={17} />
      <span>{channel.name}</span>
      {owner && (
        <button className="icon-btn del" title="Apagar canal" onClick={remove}>
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

function VoiceUsers({ channelId }: { channelId: number }) {
  const users = useStore((s) => s.voiceStates[channelId])
  const names = useStore((s) => s.users)
  const speaking = useStore((s) => s.speaking)
  if (!users?.length) return null
  return (
    <div className="voice-users">
      {users.map((u) => {
        const name = names[u.user_id]?.username ?? '…'
        return (
          <div key={u.user_id} className={`voice-user ${speaking[u.user_id] && !u.muted ? 'speaking' : ''}`}>
            <Avatar id={u.user_id} name={name} size={20} />
            <span>{name}</span>
            {u.screen && <span className="live">AO VIVO</span>}
            {u.camera && <Video size={14} />}
            {u.deafened ? <HeadphoneOff size={14} /> : u.muted && <MicOff size={14} />}
          </div>
        )
      })}
    </div>
  )
}

const QUALITY_LABEL = { good: 'Voz conectada', fair: 'Conexão instável', poor: 'Conexão fraca' } as const

function qualityTitle(q: Quality | null) {
  if (!q) return 'Medindo a conexão…'
  // Below 10 ms (same machine / LAN) one decimal is meaningful; above it, whole ms.
  const ms = q.rtt === null ? null : q.rtt < 10 ? q.rtt.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : Math.round(q.rtt).toString()
  const parts = [ms !== null ? `Latência ${ms === '0' ? '<0,1' : ms} ms` : 'Latência medindo…', `Perda ${(q.loss * 100).toFixed(1)}%`]
  const hint = q.level === 'good' ? '' : '\nO vídeo foi reduzido para manter a voz estável.'
  return parts.filter(Boolean).join(' · ') + hint
}

function VoiceBar({ onOpen }: { onOpen: () => void }) {
  const voice = useStore((s) => s.voice)
  const channel = useStore((s) => {
    const v = s.voice
    return v ? s.details[v.groupId]?.channels.find((c) => c.id === v.channelId) : undefined
  })
  const group = useStore((s) => s.groups.find((g) => g.id === s.voice?.groupId))
  const quality = useStore((s) => s.netQuality)
  if (!voice) return null
  const SignalIcon = quality?.level === 'poor' ? SignalLow : quality?.level === 'fair' ? SignalMedium : Signal
  return (
    <div className="voice-bar">
      <div className="status">
        <div role="button" style={{ cursor: 'pointer' }} onClick={() => channel && (openChannel(channel), onOpen())}>
          <strong className={`q-${quality?.level ?? 'good'}`}>{QUALITY_LABEL[quality?.level ?? 'good']}</strong>
          <small>
            {channel?.name ?? '…'} · {group?.name}
          </small>
        </div>
        <span className={`signal q-${quality?.level ?? 'good'}`} title={qualityTitle(quality)}>
          <SignalIcon size={17} />
        </span>
        <button className="icon-btn" title="Desconectar" onClick={leaveVoice}>
          <PhoneOff size={17} />
        </button>
      </div>
      <div className="row">
        <button className={`btn ghost ${voice.camera ? 'on' : ''}`} onClick={toggleCamera}>
          <Video size={15} /> Câmera
        </button>
        <button className={`btn ghost ${voice.screen ? 'on' : ''}`} onClick={toggleScreen}>
          <MonitorUp size={15} /> Tela
        </button>
      </div>
    </div>
  )
}

function MePanel() {
  const me = useStore((s) => s.me)
  const voice = useStore((s) => s.voice)
  const connected = useStore((s) => s.connected)
  const [menu, setMenu] = useState<'audioinput' | 'audiooutput' | null>(null)
  const toggleMenu = (kind: 'audioinput' | 'audiooutput') => setMenu((m) => (m === kind ? null : kind))
  if (!me) return null
  return (
    <div className="me">
      <Avatar id={me.id} name={me.username} size={32} online={connected} />
      <div className="name">
        {me.username}
        <small>{connected ? 'Online' : 'Reconectando…'}</small>
      </div>
      <div className="split">
        <button className={`icon-btn ${voice?.muted ? 'off' : ''}`} title={voice?.muted ? 'Ativar microfone' : 'Silenciar'} disabled={!voice} onClick={toggleMute}>
          {voice?.muted ? <MicOff size={17} /> : <Mic size={17} />}
        </button>
        <button className={`chev ${menu === 'audioinput' ? 'open' : ''}`} title="Escolher microfone" onClick={() => toggleMenu('audioinput')}>
          <ChevronUp size={13} />
        </button>
      </div>
      <div className="split">
        <button className={`icon-btn ${voice?.deafened ? 'off' : ''}`} title={voice?.deafened ? 'Ativar áudio' : 'Ensurdecer'} disabled={!voice} onClick={toggleDeafen}>
          {voice?.deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
        </button>
        <button className={`chev ${menu === 'audiooutput' ? 'open' : ''}`} title="Escolher saída de áudio" onClick={() => toggleMenu('audiooutput')}>
          <ChevronUp size={13} />
        </button>
      </div>
      <button className="icon-btn" title="Sair" onClick={logout}>
        <LogOut size={16} />
      </button>
      {menu && <DeviceMenu key={menu} kind={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
