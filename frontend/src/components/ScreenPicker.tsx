import { AppWindow, Globe, Monitor, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { browserCapture, desktop, type CaptureSource } from '../lib/desktop'
import type { ScreenOptions } from '../lib/rtc'
import { closeScreenPicker, shareScreen } from '../store'
import { Modal } from './Modal'

type Surface = NonNullable<ScreenOptions['surface']>
type Prefs = { audio: boolean; surface: Surface }

const PREFS_KEY = 'discordia.screen'

function recallPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { audio: p.audio ?? true, surface: p.surface ?? 'browser' }
  } catch {
    return { audio: true, surface: 'browser' }
  }
}

function rememberPrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // Private mode: the picker just starts from the defaults next time.
  }
}

export function ScreenPicker() {
  return (
    <Modal onClose={closeScreenPicker} wide={!!desktop}>
      {desktop ? <DesktopPicker /> : <BrowserPicker />}
    </Modal>
  )
}

function AudioToggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <button type="button" className="toggle-row" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span>
        {label}
        <small>{hint}</small>
      </span>
      <i className={`switch ${on ? 'on' : ''}`} aria-hidden />
    </button>
  )
}

// ---------- desktop app: our own picker with live thumbnails ----------

function DesktopPicker() {
  const bridge = desktop!
  const [prefs, setPrefs] = useState(recallPrefs)
  const [tab, setTab] = useState<CaptureSource['kind']>('screen')
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Thumbnails refresh while the picker is open, like a preview.
  useEffect(() => {
    let alive = true
    const load = () =>
      bridge.getSources().then(
        (list) => alive && setSources(list),
        () => alive && setError('Não consegui listar as telas. No Mac, libere o Discordia em Ajustes → Privacidade → Gravação de tela.'),
      )
    void load()
    const timer = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [bridge])

  const visible = sources?.filter((s) => s.kind === tab) ?? []
  const chosen = sources?.find((s) => s.id === selected)

  const start = async (source = chosen) => {
    if (!source) return
    const audio = prefs.audio && bridge.systemAudio
    rememberPrefs(prefs)
    await bridge.selectSource(source.id, audio)
    await shareScreen({ audio })
  }

  return (
    <>
      <h3>Compartilhar tela</h3>
      <div className="seg">
        <button type="button" className={tab === 'screen' ? 'sel' : ''} onClick={() => setTab('screen')}>
          <Monitor size={16} /> Telas
        </button>
        <button type="button" className={tab === 'window' ? 'sel' : ''} onClick={() => setTab('window')}>
          <AppWindow size={16} /> Janelas
        </button>
      </div>
      {error ? (
        <div className="error">{error}</div>
      ) : (
        <div className="sources">
          {sources === null && <span className="sources-empty">Carregando…</span>}
          {sources !== null && visible.length === 0 && <span className="sources-empty">Nenhuma janela aberta.</span>}
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`source ${s.id === selected ? 'sel' : ''}`}
              onClick={() => setSelected(s.id)}
              onDoubleClick={() => void start(s)}
            >
              <img src={s.thumbnail} alt="" />
              <span>
                {s.icon && <img className="source-icon" src={s.icon} alt="" />}
                <em>{s.name}</em>
              </span>
            </button>
          ))}
        </div>
      )}
      <AudioToggle
        on={prefs.audio && bridge.systemAudio}
        disabled={!bridge.systemAudio}
        onChange={(audio) => setPrefs({ ...prefs, audio })}
        label="Compartilhar som"
        hint={bridge.systemAudio ? 'Envia o som do computador junto com a tela' : 'Este sistema não permite capturar o som'}
      />
      <div className="actions">
        <button type="button" className="btn ghost" onClick={closeScreenPicker}>
          Cancelar
        </button>
        <button type="button" className="btn" disabled={!chosen} onClick={() => void start()}>
          Compartilhar
        </button>
      </div>
    </>
  )
}

// ---------- browser: preselect the kind and audio, then the browser's picker chooses the exact one ----------

const SURFACES: { id: Surface; label: string; icon: LucideIcon }[] = [
  { id: 'browser', label: 'Aba', icon: Globe },
  { id: 'window', label: 'Janela', icon: AppWindow },
  { id: 'monitor', label: 'Tela inteira', icon: Monitor },
]

/** What Chromium can actually send as audio for each surface. */
function audioHint(surface: Surface) {
  const mac = /mac/i.test(navigator.platform)
  if (surface === 'browser') return 'Envia o som da aba (vídeo, música, jogo…)'
  if (surface === 'window') return 'O navegador não captura o som de janelas. Para mandar som, escolha uma aba.'
  return mac ? 'No Mac, o navegador pode não enviar o som da tela inteira. Uma aba ou o app do Mac funcionam melhor.' : 'Envia o som do computador'
}

function BrowserPicker() {
  const [prefs, setPrefs] = useState(recallPrefs)

  const start = () => {
    rememberPrefs(prefs)
    const audio = prefs.audio && browserCapture.audio && prefs.surface !== 'window'
    void shareScreen(browserCapture.hints ? { audio, surface: prefs.surface } : { audio: false })
  }

  if (!browserCapture.hints) {
    return (
      <>
        <h3>Compartilhar tela</h3>
        <p>
          O {browserCapture.name} vai abrir a seleção dele para escolher a janela ou a tela. Ele não envia o som. Para compartilhar com som, use o Chrome ou o app do
          Mac.
        </p>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={closeScreenPicker}>
            Cancelar
          </button>
          <button type="button" className="btn" autoFocus onClick={start}>
            Continuar
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <h3>Compartilhar tela</h3>
      <div className="surfaces">
        {SURFACES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={prefs.surface === id ? 'sel' : ''} onClick={() => setPrefs({ ...prefs, surface: id })}>
            <Icon size={22} />
            {label}
          </button>
        ))}
      </div>
      <AudioToggle
        on={prefs.audio && prefs.surface !== 'window'}
        disabled={prefs.surface === 'window'}
        onChange={(audio) => setPrefs({ ...prefs, audio })}
        label="Compartilhar som"
        hint={audioHint(prefs.surface)}
      />
      <p className="hint">Em seguida o navegador pergunta qual {prefs.surface === 'browser' ? 'aba' : prefs.surface === 'window' ? 'janela' : 'tela'} compartilhar.</p>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={closeScreenPicker}>
          Cancelar
        </button>
        <button type="button" className="btn" autoFocus onClick={start}>
          Continuar
        </button>
      </div>
    </>
  )
}
