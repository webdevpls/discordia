const HUES = [250, 200, 160, 30, 340, 280, 15, 190]

export function Avatar({ id, name, size = 32, online }: { id: number; name: string; size?: number; online?: boolean }) {
  const hue = HUES[id % HUES.length]
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 45% 52%)` }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
      {online !== undefined && <i className={`dot ${online ? 'on' : ''}`} />}
    </div>
  )
}
