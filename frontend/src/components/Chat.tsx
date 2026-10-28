import { SendHorizontal } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Channel, Message } from '../lib/types'
import { loadMessages, notifyTyping, sendMessage, toast, useStore } from '../store'
import { Avatar } from './Avatar'

const GROUP_WINDOW = 5 * 60 * 1000
const EMPTY: Message[] = []

const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })

function stamp(iso: string) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `Hoje às ${time.format(d)}` : `${day.format(d)} ${time.format(d)}`
}

const URL_RE = /(https?:\/\/[^\s<]+)/g

function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer noopener">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

export function Chat({ channel }: { channel: Channel }) {
  const messages = useStore((s) => s.messages[channel.id] ?? EMPTY)
  const hasMore = useStore((s) => s.hasMore[channel.id])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevHeight = useRef(0)

  // Keep pinned to the bottom unless the user scrolled up; preserve position when older pages load.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else if (prevHeight.current && el.scrollTop < 50) el.scrollTop += el.scrollHeight - prevHeight.current
    prevHeight.current = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = scroller.current!
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <>
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {hasMore ? (
          <button className="load-more" onClick={() => loadMessages(channel.id, messages[0]?.id)}>
            Carregar mensagens anteriores
          </button>
        ) : (
          <div className="intro">
            <h3>Bem-vindo a #{channel.name}</h3>
            <p>Este é o começo do canal.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const first = !prev || prev.author.id !== m.author.id || +new Date(m.created_at) - +new Date(prev.created_at) > GROUP_WINDOW
          return (
            <div key={m.id} className={`msg ${first ? 'first' : ''}`}>
              {first ? <Avatar id={m.author.id} name={m.author.username} size={40} /> : <div />}
              {first && (
                <div className="meta">
                  <strong>{m.author.username}</strong>
                  <time dateTime={m.created_at}>{stamp(m.created_at)}</time>
                </div>
              )}
              <div className="body">
                <Linkified text={m.content} />
              </div>
            </div>
          )
        })}
      </div>
      <Composer channel={channel} />
    </>
  )
}

function Composer({ channel }: { channel: Channel }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const content = text.trim()
    if (!content) return
    setText('')
    try {
      await sendMessage(channel.id, content)
    } catch (err) {
      setText(content)
      toast((err as Error).message)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer">
      <form onSubmit={submit}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={2000}
          placeholder={`Conversar em #${channel.name}`}
          onKeyDown={onKey}
          onChange={(e) => {
            setText(e.target.value)
            notifyTyping(channel.id)
          }}
        />
        <button className="icon-btn" title="Enviar" disabled={!text.trim()}>
          <SendHorizontal size={18} />
        </button>
      </form>
      <Typing channelId={channel.id} />
    </div>
  )
}

function Typing({ channelId }: { channelId: number }) {
  const typing = useStore((s) => s.typing[channelId])
  const users = useStore((s) => s.users)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!typing) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [typing])

  const names = Object.entries(typing ?? {})
    .filter(([, until]) => until > now)
    .map(([id]) => users[Number(id)]?.username)
    .filter(Boolean)

  let label = ''
  if (names.length === 1) label = `${names[0]} está digitando…`
  else if (names.length === 2) label = `${names[0]} e ${names[1]} estão digitando…`
  else if (names.length > 2) label = 'Várias pessoas estão digitando…'
  return <div className="typing">{label}</div>
}
