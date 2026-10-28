import type { Member } from '../lib/types'
import { useStore } from '../store'
import { Avatar } from './Avatar'

export function Members({ groupId }: { groupId: number }) {
  const detail = useStore((s) => s.details[groupId])
  const online = useStore((s) => s.online)
  const ownerId = useStore((s) => s.groups.find((g) => g.id === groupId)?.owner_id)
  if (!detail) return <aside className="members" />

  const on = detail.members.filter((m) => online[m.id])
  const off = detail.members.filter((m) => !online[m.id])
  const row = (m: Member, isOn: boolean) => (
    <div key={m.id} className={`member ${isOn ? '' : 'offline-m'}`}>
      <Avatar id={m.id} name={m.username} size={30} online={isOn} />
      <span style={{ flex: 1 }}>{m.username}</span>
      {m.id === ownerId && <small>dono</small>}
    </div>
  )
  return (
    <aside className="members">
      <div className="section">
        <span className="label">Online — {on.length}</span>
      </div>
      {on.map((m) => row(m, true))}
      {off.length > 0 && (
        <>
          <div className="section" style={{ marginTop: 12 }}>
            <span className="label">Offline — {off.length}</span>
          </div>
          {off.map((m) => row(m, false))}
        </>
      )}
    </aside>
  )
}
