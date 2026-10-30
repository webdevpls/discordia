// Casca nativa do Discordia: abre o servidor escolhido numa janela e troca a
// seleção de tela do sistema pelo seletor do próprio app (estilo Discord).
const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, session, shell, systemPreferences } = require('electron')
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
  e.returnValue = { platform: process.platform, systemAudio: SYSTEM_AUDIO }
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
  win.on('closed', () => (win = null))

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
