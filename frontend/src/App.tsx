import { ChevronLeft, Hash, Users, Volume2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Auth } from './components/Auth'
import { Chat } from './components/Chat'
import { Members } from './components/Members'
import { Rail } from './components/Rail'
import { ScreenPicker } from './components/ScreenPicker'
import { Sidebar } from './components/Sidebar'
import { AudioSink, Stage } from './components/Stage'
import { boot, useStore } from './store'

export default function App() {
  const me = useStore((s) => s.me)
  const booting = useStore((s) => s.booting)
  const toast = useStore((s) => s.toast)
  const screenPicker = useStore((s) => s.screenPicker)

  useEffect(() => {
    void boot()
  }, [])

  if (booting) return null
  return (
    <>
      {me ? <Shell /> : <Auth />}
      <AudioSink />
      {screenPicker && <ScreenPicker />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  )
}

function Shell() {
  const groupId = useStore((s) => s.activeGroupId)
  const channel = useStore((s) => {
    const d = s.activeGroupId ? s.details[s.activeGroupId] : undefined
    return d?.channels.find((c) => c.id === s.activeChannelId)
  })
  const connected = useStore((s) => s.connected)
  const [showMembers, setShowMembers] = useState(true)
  const [mobileMain, setMobileMain] = useState(false)

  const members = showMembers && channel?.kind === 'text' && groupId
  const cls = ['shell', members ? 'with-members' : '', mobileMain ? 'show-main' : ''].join(' ')

  return (
    <div className={cls}>
      <Rail />
      <Sidebar onOpen={() => setMobileMain(true)} />
      <main className="main">
        <header className="main-head">
          <button className="icon-btn back" title="Voltar" onClick={() => setMobileMain(false)}>
            <ChevronLeft size={18} />
          </button>
          {channel && (channel.kind === 'text' ? <Hash size={18} /> : <Volume2 size={18} />)}
          <span>{channel?.name ?? ''}</span>
          <span className="grow" />
          {!connected && <span className="offline">Reconectando…</span>}
          {channel?.kind === 'text' && (
            <button className="icon-btn" title="Membros" onClick={() => setShowMembers((v) => !v)}>
              <Users size={18} />
            </button>
          )}
        </header>
        {channel ? (
          channel.kind === 'text' ? (
            <Chat key={channel.id} channel={channel} />
          ) : (
            <Stage channel={channel} />
          )
        ) : (
          <div className="empty">
            <h3>Nada por aqui ainda</h3>
            <span>Crie um grupo ou entre com um convite para começar.</span>
          </div>
        )}
      </main>
      {members && <Members groupId={groupId} />}
    </div>
  )
}
