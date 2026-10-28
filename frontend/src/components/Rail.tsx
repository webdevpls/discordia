import { Plus } from 'lucide-react'
import { useState } from 'react'
import { openGroup, useStore } from '../store'
import { AddGroupModal } from './Modals'

function initials(name: string) {
  const words = name.trim().split(/\s+/)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
}

export function Rail() {
  const groups = useStore((s) => s.groups)
  const active = useStore((s) => s.activeGroupId)
  const [adding, setAdding] = useState(false)

  return (
    <nav className="rail" aria-label="Grupos">
      {groups.map((g) => (
        <button key={g.id} className={`rail-item ${g.id === active ? 'active' : ''}`} title={g.name} onClick={() => openGroup(g.id)}>
          {initials(g.name)}
        </button>
      ))}
      {groups.length > 0 && <div className="rail-sep" />}
      <button className="rail-item add" title="Criar ou entrar em um grupo" onClick={() => setAdding(true)}>
        <Plus size={20} />
      </button>
      {adding && <AddGroupModal onClose={() => setAdding(false)} />}
    </nav>
  )
}
