import { Check, Copy, Hash, Volume2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { ChannelKind, Group } from '../lib/types'
import { createChannel, createGroup, joinGroup } from '../store'
import { Modal } from './Modal'

function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await action()
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

export function AddGroupModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [value, setValue] = useState('')
  const { busy, error, submit } = useSubmit(() => (mode === 'create' ? createGroup(value.trim()) : joinGroup(value.trim())), onClose)

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h3>{mode === 'create' ? 'Criar grupo' : 'Entrar em um grupo'}</h3>
        <div className="seg">
          <button type="button" className={mode === 'create' ? 'sel' : ''} onClick={() => setMode('create')}>
            Criar novo
          </button>
          <button type="button" className={mode === 'join' ? 'sel' : ''} onClick={() => setMode('join')}>
            Tenho um convite
          </button>
        </div>
        <input
          className="input"
          autoFocus
          key={mode}
          placeholder={mode === 'create' ? 'Nome do grupo' : 'Código do convite'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !value.trim()}>
            {mode === 'create' ? 'Criar' : 'Entrar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function CreateChannelModal({ groupId, kind: initialKind, onClose }: { groupId: number; kind: ChannelKind; onClose: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(initialKind)
  const [name, setName] = useState('')
  const { busy, error, submit } = useSubmit(() => createChannel(groupId, name.trim(), kind), onClose)

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h3>Novo canal</h3>
        <div className="seg">
          <button type="button" className={kind === 'text' ? 'sel' : ''} onClick={() => setKind('text')}>
            <Hash size={16} /> Texto
          </button>
          <button type="button" className={kind === 'voice' ? 'sel' : ''} onClick={() => setKind('voice')}>
            <Volume2 size={16} /> Voz
          </button>
        </div>
        <input className="input" autoFocus placeholder="Nome do canal" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" disabled={busy || !name.trim()}>
            Criar canal
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function InviteModal({ group, onClose }: { group: Group; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(group.invite_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <Modal onClose={onClose}>
      <h3>Convidar para {group.name}</h3>
      <p>Envie este código. Quem tiver ele pode entrar no grupo.</p>
      <div className="code">
        <input className="input" readOnly value={group.invite_code} onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={copy}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </Modal>
  )
}
