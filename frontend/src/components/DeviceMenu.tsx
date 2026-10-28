import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { setAudioInput, setAudioOutput, toggleNoiseSuppression, useStore } from '../store'

/** Lists audio devices; labels are only exposed after mic permission, so it asks once if needed. */
function useAudioDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md) return
    let alive = true
    const load = async () => {
      let list = await md.enumerateDevices()
      if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
        try {
          const s = await md.getUserMedia({ audio: true })
          s.getTracks().forEach((t) => t.stop())
          list = await md.enumerateDevices()
        } catch {
          /* no permission: show unnamed devices */
        }
      }
      // Chrome adds "default"/"communications" aliases; "Padrão do sistema" covers them.
      if (alive) setDevices(list.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications'))
    }
    void load()
    md.addEventListener('devicechange', load)
    return () => {
      alive = false
      md.removeEventListener('devicechange', load)
    }
  }, [kind])
  return devices
}

const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** Upward popover with the input or output devices, anchored to the user panel. */
export function DeviceMenu({ kind, onClose }: { kind: 'audioinput' | 'audiooutput'; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const devices = useAudioDevices(kind)
  const input = kind === 'audioinput'
  const value = useStore((s) => (input ? s.audioInput : s.audioOutput))
  const noise = useStore((s) => s.noiseSuppression)
  // A saved device that isn't plugged in shows as default.
  const current = devices.some((d) => d.deviceId === value) ? value : ''

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The chevron toggles the menu itself, so clicks on it are left alone.
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('.chev')) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const pick = (id: string) => {
    if (input) void setAudioInput(id)
    else setAudioOutput(id)
    onClose()
  }

  return (
    <div className="device-menu" ref={ref} role="menu">
      <span className="label">{input ? 'Dispositivo de entrada' : 'Dispositivo de saída'}</span>
      {!input && !canPickOutput ? (
        <p className="hint">Este navegador não permite escolher a saída; ele usa a do sistema.</p>
      ) : (
        <>
          {[{ deviceId: '', label: 'Padrão do sistema' }, ...devices].map((d, i) => (
            <button key={d.deviceId || 'default'} role="menuitemradio" aria-checked={d.deviceId === current} onClick={() => pick(d.deviceId)}>
              <span>{d.label || `${input ? 'Microfone' : 'Saída'} ${i}`}</span>
              {d.deviceId === current && <Check size={15} />}
            </button>
          ))}
          {input && (
            <button className="toggle-row" role="menuitemcheckbox" aria-checked={noise} onClick={() => void toggleNoiseSuppression()}>
              <span>
                Supressão de ruído
                <small>Remove teclado, ventilador e barulho de fundo</small>
              </span>
              <i className={`switch ${noise ? 'on' : ''}`} aria-hidden />
            </button>
          )}
          {input && <p className="hint">Fone Bluetooth com som robótico? Use o microfone do computador e deixe o fone só como saída.</p>}
        </>
      )}
    </div>
  )
}
