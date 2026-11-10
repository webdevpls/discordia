// Casca nativa do Discordia: abre o servidor escolhido numa janela e troca a
// seleção de tela do sistema pelo seletor do próprio app (estilo Discord).
const { app, BrowserWindow, Menu, Tray, desktopCapturer, ipcMain, nativeImage, session, shell, systemPreferences } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

/** Sugerido na primeira abertura; cada pessoa pode usar o próprio servidor. */
const DEFAULT_SERVER = 'https://discordia.visionstds.com.br'
const SETUP_PAGE = path.join(__dirname, 'ui', 'index.html')

// Som do sistema junto com a tela. No Windows é nativo; no macOS 13+ vem do
// ScreenCaptureKit, que no Chromium ainda está atrás destas flags.
const MAC_AUDIO = process.platform === 'darwin' && Number(require('node:os').release().split('.')[0]) >= 22
if (MAC_AUDIO) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
const SYSTEM_AUDIO = process.platform === 'win32' || MAC_AUDIO

// O Chromium força codificação em software (OpenH264) para compartilhamento de
// tela. No Mac isso consumia ~1 núcleo inteiro só para codificar a tela em 1080p;
// desligado, ela vai para o encoder de hardware (VideoToolbox), como a câmera.
app.commandLine.appendSwitch('disable-features', 'WebRtcScreenshareSwEncoding')

/** Servidor em uso. Câmera, microfone e tela só são liberados para ele. */
let server = null
let win = null
/** Fonte escolhida no seletor, consumida pelo próximo getDisplayMedia. */
let pending = null

const configFile = () => path.join(app.getPath('userData'), 'server.txt')

/** Aceita "meuservidor.com" ou a URL completa. HTTP só para a própria máquina,
 *  porque o navegador bloqueia câmera e microfone em páginas sem HTTPS. */
function parseServer(input) {
  const text = String(input).trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    throw new Error('Endereço inválido.')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && local) return url
  if (url.protocol === 'http:') throw new Error('Use https://: sem HTTPS o navegador bloqueia câmera e microfone.')
  throw new Error('Endereço inválido.')
}

function savedServer() {
  try {
    return parseServer(process.env.DISCORDIA_URL || fs.readFileSync(configFile(), 'utf8'))
  } catch {
    return null
  }
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Só a página do servidor escolhido (e não um site qualquer aberto nela) ganha acesso. */
function trusted(webContents) {
  return !!server && !!webContents && originOf(webContents.getURL()) === server.origin
}

// ---------- seletor de tela ----------

ipcMain.handle('screen:sources', async (e) => {
  if (!trusted(e.sender)) throw new Error('Não permitido.')
  // Na primeira vez, isto faz o macOS pedir a permissão de gravação de tela.
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  })
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error('Sem permissão de gravação de tela.')
  }
  const own = win?.getMediaSourceId()
  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  return sources
    .filter((s) => s.id !== own)
    .map((s) => {
      const screen = screens.indexOf(s)
      return {
        id: s.id,
        name: screen < 0 ? s.name : screens.length > 1 ? `Tela ${screen + 1}` : 'Tela inteira',
        kind: screen < 0 ? 'window' : 'screen',
        thumbnail: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
      }
    })
})

ipcMain.handle('screen:select', (e, id, audio) => {
  if (!trusted(e.sender)) throw new Error('Não permitido.')
  pending = { id: String(id), audio: !!audio && SYSTEM_AUDIO }
})

ipcMain.on('desktop:info', (e) => {
  e.returnValue = { platform: process.platform, systemAudio: SYSTEM_AUDIO, version: app.getVersion() }
})

// ---------- ícone da chamada na barra de menu ----------
// O clique abre um painel pequeno (HTML puro, sem framework) que fica aberto
// enquanto você muta/desmuta. Ele é criado no clique e destruído ao fechar:
// parado, não existe processo nenhum. A página só manda o estado quando muda.

let tray = null
let call = null
let panel = null
const trayIcons = {}
const PANEL_WIDTH = 272

function trayIcon(muted) {
  const name = muted ? 'muted' : 'call'
  // O macOS pega o @2x sozinho nas telas Retina.
  return (trayIcons[name] ??= nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray', `${name}.png`)))
}

const text = (v, max = 60) => String(v ?? '').slice(0, max)

/** Aceita só o formato esperado vindo da página. */
function parseCall(s) {
  if (!s || typeof s !== 'object') return null
  const people = Array.isArray(s.people) ? s.people.slice(0, 50) : []
  return {
    channel: text(s.channel),
    group: text(s.group),
    muted: !!s.muted,
    deafened: !!s.deafened,
    camera: !!s.camera,
    screen: !!s.screen,
    hasMic: !!s.hasMic,
    people: people.map((p) => ({
      id: Number(p?.id) || 0,
      name: text(p?.name, 40),
      self: !!p?.self,
      muted: !!p?.muted,
      deafened: !!p?.deafened,
      camera: !!p?.camera,
      screen: !!p?.screen,
    })),
  }
}

function setCall(next) {
  call = next
  if (!call) {
    tray?.destroy()
    tray = null
    closePanel()
    return
  }
  const muted = call.muted || call.deafened
  if (!tray) {
    tray = new Tray(trayIcon(muted))
    tray.on('click', togglePanel)
    tray.on('right-click', togglePanel)
  } else {
    tray.setImage(trayIcon(muted))
  }
  const state = call.deafened ? ' (sem som)' : call.muted ? ' (mudo)' : ''
  tray.setToolTip(`Discordia: em chamada em ${call.channel}${state}`)
  panel?.webContents.send('tray:state', call)
}

function closePanel() {
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
}

function placePanel() {
  if (!panel || !tray) return
  const t = tray.getBounds()
  const { width } = panel.getBounds()
  panel.setPosition(Math.round(t.x + t.width / 2 - width / 2), Math.round(t.y + t.height + 4))
}

function togglePanel() {
  if (panel) return closePanel()
  if (!call) return
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'tray', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Uma página estática: sem cache de disco, spellcheck nem extras.
      spellcheck: false,
      backgroundThrottling: true,
    },
  })
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panel.on('blur', closePanel)
  panel.on('closed', () => (panel = null))
  panel.webContents.on('will-navigate', (e) => e.preventDefault())
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void panel.loadFile(path.join(__dirname, 'ui', 'tray', 'index.html'))
}

const fromPanel = (e) => !!panel && !panel.isDestroyed() && e.sender === panel.webContents

ipcMain.handle('tray:ready', (e) => (fromPanel(e) ? call : null))

// O painel mede o próprio conteúdo; a janela acompanha e aparece já no lugar certo.
ipcMain.on('tray:height', (e, height) => {
  if (!fromPanel(e)) return
  const h = Math.max(80, Math.min(600, Math.ceil(Number(height) || 0)))
  panel.setContentSize(PANEL_WIDTH, h)
  placePanel()
  if (!panel.isVisible()) {
    panel.show()
    panel.focus()
  }
})

ipcMain.on('tray:command', (e, cmd) => {
  if (!fromPanel(e)) return
  if (!['mute', 'deafen', 'camera', 'screen', 'leave', 'open', 'close'].includes(cmd)) return
  // Liga/desliga deixa o painel aberto; o resto leva para o app ou encerra.
  if (cmd !== 'mute' && cmd !== 'deafen' && cmd !== 'camera') closePanel()
  if (cmd !== 'close') sendCommand(cmd)
})

function sendCommand(cmd) {
  if (!win || !trusted(win.webContents)) return
  // Escolher a tela e abrir o app precisam da janela à vista.
  if (cmd === 'screen' || cmd === 'open') {
    if (win.isMinimized()) win.restore()
    win.show()
    app.focus({ steal: true })
  }
  if (cmd !== 'open') win.webContents.send('call:command', cmd)
}

ipcMain.on('call:state', (e, state) => {
  if (!win || e.sender !== win.webContents || !trusted(e.sender)) return
  setCall(parseCall(state))
})

// ---------- tela de escolha do servidor ----------

ipcMain.handle('server:current', () => (savedServer() ?? new URL(DEFAULT_SERVER)).href)

ipcMain.handle('server:connect', async (e, input) => {
  if (!e.sender.getURL().startsWith('file:')) throw new Error('Não permitido.')
  const url = parseServer(input)
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), url.href)
  server = url
  await win.loadURL(url.href)
})

function openSetup() {
  server = null
  win?.loadFile(SETUP_PAGE)
}

function buildMenu() {
  const server = { label: 'Trocar servidor…', click: openSetup }
  const first =
    process.platform === 'darwin'
      ? { role: 'appMenu', submenu: [{ role: 'about' }, server, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }
      : { role: 'fileMenu', submenu: [server, { type: 'separator' }, { role: 'quit' }] }
  Menu.setApplicationMenu(Menu.buildFromTemplate([first, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]))
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Discordia',
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 520,
    backgroundColor: '#0c0c0e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Chamadas continuam fluidas com a janela em segundo plano.
      backgroundThrottling: false,
    },
  })

  // Links externos abrem no navegador, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const target = new URL(url)
    if (target.protocol === 'file:' || (server && target.origin === server.origin)) return
    e.preventDefault()
    if (/^https?:$/.test(target.protocol)) void shell.openExternal(url)
  })
  // A chamada termina junto com a página (recarregar, trocar de servidor, travar, fechar).
  win.webContents.on('did-start-navigation', (e) => e.isMainFrame && !e.isSameDocument && setCall(null))
  win.webContents.on('render-process-gone', () => setCall(null))
  win.on('closed', () => {
    win = null
    setCall(null)
  })

  server = savedServer()
  if (server) void win.loadURL(server.href)
  else void win.loadFile(SETUP_PAGE)
}

app.whenReady().then(() => {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback((permission === 'media' || permission === 'display-capture') && trusted(webContents))
  })
  ses.setPermissionCheckHandler((webContents, permission) => (permission === 'media' || permission === 'display-capture') && trusted(webContents))

  // getDisplayMedia entrega direto o que foi escolhido no seletor do app,
  // sem abrir a seleção do sistema.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = pending
    pending = null
    if (!choice || !server || originOf(request.securityOrigin) !== server.origin) return callback({})
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
    const video = sources.find((s) => s.id === choice.id)
    if (!video) return callback({})
    callback(choice.audio ? { video, audio: 'loopback' } : { video })
  })

  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
